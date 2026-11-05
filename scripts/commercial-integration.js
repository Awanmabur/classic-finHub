#!/usr/bin/env node
'use strict';
// Destructive test records are random and localhost-only. Never run in production.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const env=require('../src/config/env');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const {ensureTenantIndexes,branchModel,tenantUserModel,staffInviteModel}=require('../src/tenant/models');
const Tenant=require('../src/platform/models/Tenant');
const UsageCounter=require('../src/platform/models/UsageCounter');
const OutboxEvent=require('../src/platform/models/OutboxEvent');
const Audit=require('../src/platform/models/PlatformAuditLog');
const commerce=require('../src/platform/services/commercial.service');
function localOnly(){
  if(env.nodeEnv==='production')throw new Error('Commercial probe must not run in production');
  const uri=new URL(env.mongoPlatformUri);
  if(uri.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(uri.hostname)||uri.host.includes(','))
    throw new Error('Commercial integration requires single-node loopback MongoDB only');
}
async function main(){
  localOnly();await connectPlatformMongo();verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
  await Promise.all([Tenant.createIndexes(),UsageCounter.createIndexes(),Audit.createIndexes(),OutboxEvent.createIndexes()]);
  const published=await commerce.latestPublished('agent');
  if(!published)throw new Error('Publish the local starter catalogue first: npm run catalog:publish -- --apply');
  const nonce=crypto.randomBytes(8).toString('hex'),slug=`probe-commerce-${nonce}`;
  const admin={id:String(new mongoose.Types.ObjectId()),name:'Integration administrator',permissions:['*']};
  const conn=getTenantConnection(slug);let tenant;
  try{
    await ensureTenantIndexes(conn);
    const snapshot=commerce.planSnapshot(published);
    tenant=await Tenant.create({name:'Commerce Scratch Tenant',slug,dbName:`classicfin_tenant_${slug.replace(/-/g,'_')}_db`,
      email:`commerce-${nonce}@example.invalid`,owner:'Probe Owner',plan:'agent',status:'active',setupStatus:'complete',
      seatsReserved:1,branchCount:0,enabledModules:snapshot.modules,
      subscription:{...snapshot,status:'granted',source:'manual_admin_grant',periodStart:new Date(Date.now()-86400000),
        periodEnd:new Date(Date.now()+4*86400000),generation:1}});
    const before=await Tenant.findById(tenant._id).lean();
    assert(commerce.effectiveSubscription(before));
    await assert.rejects(commerce.grantTenantSubscription(String(tenant._id),{id:'any',permissions:[]},{planCode:'agent',days:1,reason:'Authorized integration test renewal'}),e=>e.status===403);
    const granted=await commerce.grantTenantSubscription(String(tenant._id),admin,{planCode:'agent',days:1,reason:'Controlled integration test renewal of current plan'});
    assert.equal(granted.subscription.generation,1,'same-plan renewal must not reset usage generation');
    assert(granted.subscription.periodEnd>before.subscription.periodEnd);
    assert.equal(await Audit.countDocuments({recordId:String(tenant._id),action:'subscription.manual_grant'}),1);
    assert.equal(await OutboxEvent.countDocuments({tenantId:tenant._id,type:'subscription.granted'}),1,'grant and notification must commit together');
    const branch=await branchModel(conn).create({name:'Scratch Branch',code:'scratch',currency:'UGX',createdBy:admin.id,updatedBy:admin.id});
    assert(branch);
    // Locally reduce the test tenant's quota; real plans remain untouched.
    await Tenant.updateOne({_id:tenant._id},{$set:{'subscription.limits.transactionsPerMonth':2}});
    tenant=await Tenant.findById(tenant._id).lean();
    for(let n=0;n<2;n++){
      const session=await mongoose.startSession();
      try{await session.withTransaction(async()=>{await commerce.reserveUsage(tenant,'mobile_money_records',session);});}
      finally{await session.endSession();}
    }
    const period=commerce.periodKey();
    assert.equal((await UsageCounter.findOne({tenantId:tenant._id,generation:1,period,metric:'mobile_money_records'})).quantity,2);
    const denied=await mongoose.startSession();
    try{await assert.rejects(denied.withTransaction(async()=>commerce.reserveUsage(tenant,'mobile_money_records',denied)),e=>e.status===429);}
    finally{await denied.endSession();}
    const rollback=await mongoose.startSession();
    try{
      await Tenant.updateOne({_id:tenant._id},{$set:{'subscription.limits.transactionsPerMonth':3}});
      const bumped=await Tenant.findById(tenant._id).lean();
      await assert.rejects(rollback.withTransaction(async()=>{
        await commerce.reserveUsage(bumped,'mobile_money_records',rollback);
        throw new Error('deliberate transaction rollback');
      }),/deliberate transaction rollback/);
    }finally{await rollback.endSession();}
    assert.equal((await UsageCounter.findOne({tenantId:tenant._id,generation:1,period,metric:'mobile_money_records'})).quantity,2,'rollback must not consume quota');
    const revoked=await commerce.revokeTenantSubscription(String(tenant._id),admin,{reason:'Controlled cancellation for integration verification'});
    assert.equal(revoked.subscription.status,'revoked');
    assert.equal(commerce.effectiveSubscription(revoked),null);
    await assert.rejects(commerce.reserveUsage(revoked,'mobile_money_records',{}),e=>e.status===403);
    const restored=await commerce.grantTenantSubscription(String(tenant._id),admin,{planCode:'agent',days:1,reason:'Controlled reactivation for integration verification'});
    assert.equal(restored.subscription.generation,2,'reactivation gets separate quota generation');
    assert(commerce.effectiveSubscription(restored));
    if(await commerce.latestPublished('finance')){
      const person=await tenantUserModel(conn).create({name:'Scratch Operator',email:`staff-${nonce}@example.invalid`,
        passwordHash:'not-a-login-password-hash',role:'Mobile Money Operator',branchId:String(branch._id),
        allowedModules:['mobile_money'],status:'active'});
      const pending=await staffInviteModel(conn).create({name:'Scratch Invite',email:`pending-${nonce}@example.invalid`,
        role:'Mobile Money Operator',branchId:String(branch._id),allowedModules:['mobile_money'],
        tokenHash:crypto.randomBytes(32).toString('hex'),status:'pending',createdBy:admin.id,
        expiresAt:new Date(Date.now()+3600000)});
      await commerce.grantTenantSubscription(String(tenant._id),admin,{planCode:'finance',days:7,
        reason:'Controlled module downgrade and session revocation verification'});
      const contracted=await tenantUserModel(conn).findById(person._id).lean();
      const pendingUpdated=await staffInviteModel(conn).findById(pending._id).lean();
      assert.deepEqual(contracted.allowedModules,[]);assert(contracted.authVersion>0);
      assert.deepEqual(pendingUpdated.allowedModules,[]);
      await commerce.grantTenantSubscription(String(tenant._id),admin,{planCode:'agent',days:7,
        reason:'Controlled re-upgrade without restoring old staff grants'});
      assert.deepEqual((await tenantUserModel(conn).findById(person._id)).allowedModules,[],
        'plan upgrade must not silently restore removed staff permissions');
    }
    console.log('PASS: published plan, manual grant, extension, audit, bounded quota, rejection, rollback, revocation, reactivation and safe staff-permission downgrade (local scratch only)');
  } finally {
    if(/^probe-commerce-[a-f0-9]{16}$/.test(slug)){
      if(tenant){await UsageCounter.deleteMany({tenantId:tenant._id});await OutboxEvent.deleteMany({tenantId:tenant._id});await Audit.deleteMany({recordId:String(tenant._id)});await Tenant.deleteOne({_id:tenant._id,slug});}
      await conn.db.dropDatabase();
    }
    await mongoose.disconnect();
  }
}
main().catch(e=>{console.error('Commercial integration FAILED:',e.stack||e.message);process.exitCode=1;mongoose.disconnect().catch(()=>{});});
