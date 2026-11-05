#!/usr/bin/env node
'use strict';
// Only random scratch platform/tenant databases on a loopback replica set.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)
  throw Error('Transaction branch integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),scratchName=`cfh_branch_probe_${nonce}`,slug=`probe-branch-${nonce}`;
configured.pathname='/'+scratchName;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const Tenant=require('../src/platform/models/Tenant');
const models=require('../src/tenant/models');
const branches=require('../src/tenant/services/branch.service');
const context=require('../src/tenant/services/transactionBranch.service');
const mobile=require('../src/tenant/services/mobileMoney.service');
const cash=require('../src/tenant/services/cashDrawer.service');
const {permissionsFor}=require('../src/config/roles');
const commercial=require('../src/platform/services/commercial.service');
let conn;
async function main(){
  await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
  await Tenant.createIndexes();await require('../src/platform/models/UsageCounter').createIndexes();
  conn=getTenantConnection(slug);await models.ensureTenantIndexes(conn);
  const user=await models.tenantUserModel(conn).create({name:'Branch Probe Owner',email:`owner-${nonce}@example.invalid`,passwordHash:'integration-only-hash',role:'Tenant Owner'});
  const owner={id:String(user._id),role:'Tenant Owner',permissions:['*'],branchId:null};
  const plan=require('../src/data/store').plans.find(p=>p.code==='agent');
  const snapshot=commercial.planSnapshot({...commercial.asPlanVersion(plan),status:'published'});
  const tenant=await Tenant.create({name:'Branch Probe',slug,dbName:`classicfin_tenant_${slug.replace(/-/g,'_')}_db`,owner:user.name,email:user.email,plan:'agent',status:'active',setupStatus:'complete',enabledModules:snapshot.modules,seatsReserved:3,branchCount:0,
    subscription:{...snapshot,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
  await assert.rejects(context.resolveTransactionBranch(conn,owner),{status:409});
  const first=await branches.create(tenant,owner,{name:'Kampala',code:'kampala',currency:'UGX'});
  assert.equal((await models.tenantUserModel(conn).findById(user._id)).branchId,String(first._id),'first branch binds the owner account');
  assert.equal(String((await context.resolveTransactionBranch(conn,owner))._id),String(first._id),'a legacy owner with one branch has deterministic fallback');
  const second=await branches.create(tenant,owner,{name:'Nairobi',code:'nairobi',currency:'KES'});
  await assert.rejects(context.resolveTransactionBranch(conn,owner,{branchId:String(second._id)}),{status:409},'multiple branches cannot be selected by a form');
  const ownerAtFirst={...owner,branchId:String(first._id)};
  await assert.rejects(context.resolveTransactionBranch(conn,ownerAtFirst,{branchId:String(second._id)}),{status:403});
  await branches.setOperatingBranch(tenant,ownerAtFirst,String(second._id));
  const reloaded=await models.tenantUserModel(conn).findById(user._id).lean();
  assert.equal(reloaded.branchId,String(second._id));
  assert(await models.auditEventModel(conn).exists({action:'account.operating_branch.changed',actorId:user._id}));
  const operator={id:String(new mongoose.Types.ObjectId()),role:'Mobile Money Operator',branchId:String(second._id),allowedModules:['mobile_money'],permissions:permissionsFor('Mobile Money Operator')};
  const reviewer={id:String(new mongoose.Types.ObjectId()),role:'Reconciliation Officer',branchId:String(second._id),allowedModules:['mobile_money'],permissions:permissionsFor('Reconciliation Officer')};
  const shift=await cash.open(conn,tenant,operator,{openingCash:'0'});
  assert.equal(String(shift.branchId),String(second._id));assert.equal(shift.currency,'KES');
  await cash.decideOpening(conn,tenant,reviewer,String(shift._id),{decision:'approve',note:'Independent opening cash count verified'});
  const input={customer:'Branch Probe Customer',network:'M-Pesa',networkReference:'BRANCH-'+nonce,currency:'KES',amount:'10.50',fee:'0',idempotencyKey:crypto.randomUUID()};
  const result=await mobile.recordMobileMoney(conn,operator,input,'cash_in',tenant);
  assert.equal(String(result.created.branchId),String(second._id));assert.equal(String(result.created.amountMinor),'1050');assert.equal(result.created.entrySource,'manual');
  await assert.rejects(mobile.recordMobileMoney(conn,operator,{...input,idempotencyKey:crypto.randomUUID(),networkReference:'FORGED-'+nonce,branchId:String(first._id)},'cash_in',tenant),{status:403});
  const other=getTenantConnection(`probe-other-branch-${nonce}`);await models.ensureTenantIndexes(other);
  await assert.rejects(context.resolveTransactionBranch(other,operator),{status:403},'a branch from another tenant is never accepted');
  await other.db.dropDatabase();
  console.log('PASS: automatic account branch, owner first-branch assignment, ambiguous-owner rejection, audited reassignment, fixed currency, real cash opening/recording and cross-tenant/forged-branch rejection');
}
async function cleanup(){
  if(mongoose.connection.readyState===1&&mongoose.connection.name===scratchName&&/^cfh_branch_probe_[a-f0-9]{16}$/.test(scratchName)){
    if(conn)await conn.db.dropDatabase();
    await getTenantConnection(`probe-other-branch-${nonce}`).db.dropDatabase();
    await mongoose.connection.db.dropDatabase();
  }
  await mongoose.disconnect();
}
main().catch(e=>{console.error('TRANSACTION BRANCH INTEGRATION FAILED:',e.stack||e.message);process.exitCode=1;}).finally(()=>cleanup().catch(e=>{console.error('Branch scratch cleanup failed:',e.message);process.exitCode=1;}));
