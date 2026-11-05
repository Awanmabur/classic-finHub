#!/usr/bin/env node
'use strict';
// This script writes disposable platform records + a random tenant DB. Never use remote DBs.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const {mongoPlatformUri,nodeEnv}=require('../src/config/env');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const Tenant=require('../src/platform/models/Tenant');
const Identity=require('../src/platform/models/AccountIdentity');
const {branchModel,tenantUserModel,staffInviteModel,ensureTenantIndexes,mobileTransactionModel}=require('../src/tenant/models');
const branches=require('../src/tenant/services/branch.service');
const staff=require('../src/tenant/services/staff.service');
const money=require('../src/tenant/services/mobileMoney.service');
const cash=require('../src/tenant/services/cashDrawer.service');
const {asPlanVersion,planSnapshot}=require('../src/platform/services/commercial.service');
const {plans}=require('../src/data/store');
const snapshot=planSnapshot({...asPlanVersion(plans.find(p=>p.code==='agent')),status:'published'});
const subscription={...snapshot,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01')};
function localhostOnly(){
  if(nodeEnv==='production')throw new Error('Scratch admin integration is forbidden in production');
  const uri=new URL(mongoPlatformUri);
  if(uri.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(uri.hostname)||uri.host.includes(',')){
    throw new Error('Scratch admin integration requires loopback MongoDB only');
  }
}
async function main(){
  localhostOnly();await connectPlatformMongo();verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
  await Promise.all([Tenant.createIndexes(),Identity.createIndexes()]);
  const nonce=crypto.randomBytes(8).toString('hex'),slug=`probe-admin-${nonce}`;
  const email=`cfh-admin-probe-${nonce}@example.invalid`;
  const owner={id:String(new mongoose.Types.ObjectId()),role:'Tenant Owner',permissions:['*']};
  const conn=getTenantConnection(slug);
  let tenant=null,userId=null;const branchInviteEmail=`cfh-branch-probe-${nonce}@example.invalid`;const branchActiveEmail=`cfh-branch-active-${nonce}@example.invalid`;
  try{
    await ensureTenantIndexes(conn);
    tenant=await Tenant.create({name:'Administration Probe',slug,dbName:`classicfin_tenant_${slug.replace(/-/g,'_')}_db`,owner:'Probe Owner',email:`owner-${nonce}@example.invalid`,status:'active',setupStatus:'complete',plan:'agent',enabledModules:['mobile_money','money_transfer'],seatsReserved:1,branchCount:0,subscription});
    const first=await branches.create(tenant,owner,{name:'Kampala Main',code:'kla-main',currency:'UGX',address:'Kitende'});
    const second=await branches.create(tenant,owner,{name:'Entebbe',code:'entebbe',currency:'UGX',address:'Entebbe'});
    const third=await branches.create(tenant,owner,{name:'Jinja',code:'jinja',currency:'UGX',address:'Jinja'});
    assert.equal(await branchModel(conn).countDocuments({status:'active'}),3);
    assert.equal((await Tenant.findById(tenant._id)).branchCount,3);
    await assert.rejects(branches.create(tenant,owner,{name:'Fourth',code:'fourth',currency:'UGX'}),e=>e.status===409);
    await branches.update(tenant,owner,String(first._id),{name:'Kampala Updated',address:'Updated address'});
    assert.equal((await branchModel(conn).findById(first._id)).name,'Kampala Updated');
    await branches.archive(tenant,owner,String(third._id));
    assert.equal((await Tenant.findById(tenant._id)).branchCount,2);
    await branches.restore(tenant,owner,String(third._id));
    assert.equal((await Tenant.findById(tenant._id)).branchCount,3);
    const url=await staff.issueInvite(tenant,owner,{name:'Staff Member',email,role:'Mobile Money Operator',branchId:String(first._id),allowedModules:['mobile_money']});
    const token=url.split('#token=')[1];assert.match(token,/^[a-f0-9]{64}$/);
    await staff.acceptStaffInvite(slug,token,'Complex#TestPassword2026');
    const user=await tenantUserModel(conn).findOne({email});assert(user);
    userId=String(user._id);
    assert.equal(user.branchId,String(first._id));
    assert.deepEqual(user.allowedModules,['mobile_money']);
    await assert.rejects(staff.acceptStaffInvite(slug,token,'Complex#TestPassword2026'),e=>e.status===400);
    await staff.updateStaff(tenant,owner,userId,{name:'Updated Staff',role:'Reconciliation Officer',branchId:String(second._id),allowedModules:['mobile_money']});
    let changed=await tenantUserModel(conn).findById(userId);
    assert.equal(changed.name,'Updated Staff');assert.equal(changed.role,'Reconciliation Officer');assert.equal(changed.branchId,String(second._id));
    assert(changed.authVersion>0,'role change must revoke sessions');
    await staff.disableStaff(tenant,owner,userId);
    assert.equal((await tenantUserModel(conn).findById(userId)).status,'disabled');
    await staff.enableStaff(tenant,owner,userId);
    changed=await tenantUserModel(conn).findById(userId);
    assert.equal(changed.status,'active');assert(changed.authVersion>1);
    await assert.rejects(branches.archive(tenant,owner,String(second._id)),e=>e.status===409);
    await staff.updateStaff(tenant,owner,userId,{name:'Updated Staff',role:'Mobile Money Operator',branchId:String(second._id),allowedModules:['mobile_money']});
    const operator={id:userId,role:'Mobile Money Operator',branchId:String(second._id),allowedModules:['mobile_money']};
    const shift=await cash.open(conn,tenant,operator,{openingCash:'0'});
    await cash.decideOpening(conn,tenant,owner,String(shift._id),{decision:'approve',note:'Independent opening cash count for administration integration'});
    const recorded=await money.recordMobileMoney(conn,operator,{idempotencyKey:crypto.randomUUID(),customer:'Probe Operation',network:'MTN',networkReference:`INT-${nonce}`,currency:'UGX',amount:'1000',fee:'0'},'cash_in',tenant);
    assert.equal(String(recorded.created.branchId),String(second._id));
    assert.equal((await money.getSummary(conn,{branchId:String(second._id)})).total,1);
    assert.equal((await money.getSummary(conn,{branchId:String(first._id)})).total,0);
    await assert.rejects(branches.archive(tenant,owner,String(second._id)),e=>e.status===409,'a pending record must block branch archive');
    // Delegated administration must enforce branch and role limits inside database predicates.
    const branchManager={id:String(new mongoose.Types.ObjectId()),role:'Branch Manager',branchId:String(first._id),allowedModules:['mobile_money']};
    await assert.rejects(staff.issueInvite(tenant,branchManager,{name:'Other Branch',email:branchInviteEmail,role:'Mobile Money Operator',branchId:String(second._id),allowedModules:['mobile_money']}),e=>e.status===403);
    await assert.rejects(staff.issueInvite(tenant,branchManager,{name:'Reviewer Attempt',email:branchInviteEmail,role:'Reconciliation Officer',branchId:String(first._id),allowedModules:['mobile_money']}),e=>e.status===403);
    await assert.rejects(staff.disableStaff(tenant,branchManager,userId),e=>e.status===404);
    await assert.rejects(staff.enableStaff(tenant,branchManager,userId),e=>e.status===404);
    const delegated=await staff.issueInvite(tenant,branchManager,{name:'Branch Operator',email:branchInviteEmail,role:'Mobile Money Operator',branchId:String(first._id),allowedModules:['mobile_money']});
    const activeInvite=await staff.issueInvite(tenant,branchManager,{name:'Branch Viewer',email:branchActiveEmail,role:'Viewer',branchId:String(first._id),allowedModules:[]});
    const pending=await staffInviteModel(conn).findOne({email:branchInviteEmail});assert(pending);
    await staff.cancelInvite(tenant,branchManager,String(pending._id));
    assert.equal((await staffInviteModel(conn).findById(pending._id)).status,'cancelled');
    await staff.acceptStaffInvite(slug,activeInvite.split('#token=')[1],'Complex#TestPassword2026');
    const branchViewer=await tenantUserModel(conn).findOne({email:branchActiveEmail});assert(branchViewer);
    await assert.rejects(staff.updateStaff(tenant,branchManager,String(branchViewer._id),{name:'Escalate',role:'Reconciliation Officer',branchId:String(first._id),allowedModules:['mobile_money']}),e=>e.status===403);
    await assert.rejects(staff.updateStaff(tenant,branchManager,String(branchViewer._id),{name:'Move',role:'Viewer',branchId:String(second._id),allowedModules:[]}),e=>e.status===403);
    await staff.updateStaff(tenant,branchManager,String(branchViewer._id),{name:'Branch Viewer Updated',role:'Viewer',branchId:String(first._id),allowedModules:[]});
    const beforeDisable=(await tenantUserModel(conn).findById(branchViewer._id)).authVersion;
    await staff.disableStaff(tenant,branchManager,String(branchViewer._id));
    assert((await tenantUserModel(conn).findById(branchViewer._id)).authVersion>beforeDisable,'disabling staff must revoke sessions');
    await staff.enableStaff(tenant,branchManager,String(branchViewer._id));
    assert.equal((await tenantUserModel(conn).findById(branchViewer._id)).status,'active');
    assert.equal((await tenantUserModel(conn).findById(branchViewer._id)).branchId,String(first._id));
    const otherConn=getTenantConnection(`probe-other-${nonce}`);await ensureTenantIndexes(otherConn);
    assert.equal(await mobileTransactionModel(otherConn).countDocuments({}),0,'different tenant databases must not share financial records');
    console.log('PASS: branch quotas, delegated branch-only user administration, non-escalating roles, invitation cancellation, module scope, audit transactions, session revocation and tenant financial isolation');
  }finally{
    if(/^probe-admin-[a-f0-9]{16}$/.test(slug)){
      await Identity.deleteMany({email:{$in:[email,branchInviteEmail,branchActiveEmail]}});
      if(tenant)await Tenant.deleteOne({_id:tenant._id,slug});
      await conn.db.dropDatabase();
      await require('../src/platform/models/UsageCounter').deleteMany({tenantId:tenant?._id});
      const other=getTenantConnection(`probe-other-${nonce}`);await other.db.dropDatabase();
    }
    await mongoose.disconnect();
  }
}
main().catch(e=>{console.error('Admin integration FAILED:',e.stack||e.message);process.exitCode=1;mongoose.disconnect().catch(()=>{});});
