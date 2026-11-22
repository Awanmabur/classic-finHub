#!/usr/bin/env node
'use strict';
// Destructive isolated integration test. Never run against production or remote MongoDB.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const env=require('../src/config/env');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const Tenant=require('../src/platform/models/Tenant');
const Request=require('../src/platform/models/ModuleRequest');
const Audit=require('../src/platform/models/PlatformAuditLog');
const UsageCounter=require('../src/platform/models/UsageCounter');
const {ensureTenantIndexes,branchModel,auditEventModel,mobileTransactionModel,tenantUserModel}=require('../src/tenant/models');
const moduleSvc=require('../src/platform/services/moduleSubscriptions.service');
const requestSvc=require('../src/platform/services/moduleRequest.service');
const {hasModule}=require('../src/tenant/services/moduleAccess.service');
const reports=require('../src/tenant/services/operationsReports.service');
const mobile=require('../src/tenant/services/mobileMoney.service');
const cash=require('../src/tenant/services/cashDrawer.service');
const {permissionsFor}=require('../src/config/roles');
function localOnly(){
 if(env.nodeEnv==='production')throw Error('Integration tests are forbidden in production');
 const uri=new URL(env.mongoPlatformUri);
 if(uri.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(uri.hostname)||uri.host.includes(','))
  throw Error('Module integration requires a single-host loopback MongoDB replica set');
}
async function main(){
 localOnly();await connectPlatformMongo();verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),Request.createIndexes(),Audit.createIndexes(),UsageCounter.createIndexes()]);
 const nonce=crypto.randomBytes(8).toString('hex'),slugs=[`probe-module-${nonce}`,`probe-module-other-${nonce}`];
 const admin={id:String(new mongoose.Types.ObjectId()),name:'Integration Super Admin',permissions:['*']};
 const owner={id:String(new mongoose.Types.ObjectId()),role:'Tenant Owner',permissions:['*']};
 const tenants=[];
 try{
  for(let i=0;i<slugs.length;i++){
   const slug=slugs[i],conn=getTenantConnection(slug);
   await ensureTenantIndexes(conn);
   const branch=await branchModel(conn).create({name:'Test Branch',code:'main',currency:'UGX',createdBy:admin.id,updatedBy:admin.id});
   const tenant=await Tenant.create({name:`Module Probe ${i}`,slug,dbName:`classicfin_tenant_${slug.replace(/-/g,'_')}_db`,
     email:`module-${i}-${nonce}@example.invalid`,owner:'Test Owner',plan:'modular',status:'active',setupStatus:'complete',
     seatsReserved:1,branchCount:1,enabledModules:[]});
   tenants.push({tenant,conn,branch});
  }
  const first=tenants[0],second=tenants[1];
  assert.equal(hasModule(first.tenant,'reports'),false);
  const requested=await requestSvc.submit(first.tenant,owner,{moduleKey:'reports',reason:'Require an independent operational reporting subscription for this tenant.'});
  assert.equal(requested.status,'pending');
  await assert.rejects(requestSvc.submit(first.tenant,owner,{moduleKey:'reports',reason:'Require an independent operational reporting subscription for this tenant.'}),e=>e.status===409);
  const reason='Controlled independent module activation for authenticated workspace reporting.';
  await moduleSvc.grantModule(String(first.tenant._id),admin,{moduleKey:'reports',days:30,users:5,branches:1,recordsPerMonth:0,reason});
  assert.equal((await Request.findById(requested._id)).status,'approved');
  let t1=await Tenant.findById(first.tenant._id).lean();
  assert(hasModule(t1,'reports'));assert(!hasModule(t1,'mobile_money'));
  // Real disposable tenant role-default writes (no real customers, tenants or
  // production DBs). Prove DB isolation, audited update, revision fencing,
  // explicit staff rollout, sign-in revocation and subscription ceiling.
  const roles=require('../src/tenant/services/roleModules.service');
  await tenantUserModel(first.conn).create({_id:owner.id,name:'Tenant Owner',
   email:`owner-${nonce}@example.invalid`,passwordHash:'unused-test-credential',
   role:'Tenant Owner',status:'active',authVersion:0});
  const reportStaff=await tenantUserModel(first.conn).create({
   name:'Reports tester',email:`analyst-${nonce}@example.invalid`,
   passwordHash:'unused-test-credential',role:'Reports Analyst',
   branchId:String(first.branch._id),allowedModules:[],status:'active',authVersion:0});
  assert.deepEqual(await roles.forRole(first.conn,t1,'Reports Analyst'),[],
    'No staff member should inherit a platform-defined module preset');
  await assert.rejects(roles.save(second.conn,t1,owner,{role:'Reports Analyst',
   allowedModules:['reports'],revision:0}),e=>e.status===403,'Cross-tenant database blocked');
  await assert.rejects(roles.save(first.conn,t1,{...owner,role:'Branch Manager'},{role:'Reports Analyst',
   allowedModules:['reports'],revision:0}),e=>e.status===403,'Branch manager cannot write owner role defaults');
  await assert.rejects(roles.save(first.conn,t1,{...owner,id:String(new mongoose.Types.ObjectId())},{
   role:'Reports Analyst',allowedModules:['reports'],revision:0}),e=>e.status===403,
   'Forged owner is not a persisted active tenant owner');
  await roles.save(first.conn,t1,owner,{role:'Reports Analyst',allowedModules:['reports'],revision:0});
  assert.equal((await roles.all(first.conn,t1))['Reports Analyst'].revision,1);
  await assert.rejects(roles.save(first.conn,t1,owner,{
   role:'Reports Analyst',allowedModules:['reports'],revision:0}),e=>e.status===409,
   'Concurrent stale default update blocked');
  await assert.rejects(roles.save(first.conn,t1,owner,{
   role:'Reports Analyst',allowedModules:['mobile_money'],revision:1}),e=>e.status===403,
   'Role defaults cannot grant an unsubscribed module');
  await roles.save(first.conn,t1,owner,{
   role:'Reports Analyst',allowedModules:['reports'],revision:1,applyExisting:'yes'});
  const updatedStaff=await tenantUserModel(first.conn).findById(reportStaff._id).lean();
  assert.deepEqual(updatedStaff.allowedModules,['reports']);
  assert.equal(updatedStaff.authVersion,1,'Old staff session revoked on bulk module change');
  assert.equal((await roles.forRole(first.conn,t1,'Reports Analyst')).length,1);
  assert.equal((await roles.all(second.conn,second.tenant))['Reports Analyst'].custom,false,
   'Role templates are isolated by tenant database');
  assert.equal(await auditEventModel(first.conn).countDocuments({action:'staff.role_module_defaults.updated'}),2);
  await auditEventModel(first.conn).create({action:'branch.created',actorId:owner.id,targetId:first.branch._id,metadata:{branchId:String(first.branch._id)}});
  await auditEventModel(second.conn).create({action:'branch.archived',actorId:owner.id,targetId:second.branch._id,metadata:{branchId:String(second.branch._id)}});
  const reportUser={id:String(new mongoose.Types.ObjectId()),role:'Reports Analyst',
    permissions:permissionsFor('Reports Analyst'),branchId:String(first.branch._id),allowedModules:['reports']};
  const reportOne=await reports.generate(first.conn,t1,reportUser,{source:'all'});
  assert.deepEqual(reportOne.sources.map(s=>s.key),['workspace']);
  assert(reportOne.rows.some(r=>r.activity==='branch.created'));
  assert(!reportOne.rows.some(r=>r.activity==='branch.archived'));
  assert.deepEqual(reports.sourcesFor(second.tenant,reportUser),[],'second tenant cannot inherit subscription');
  await moduleSvc.grantModule(String(first.tenant._id),admin,{moduleKey:'mobile_money',days:30,users:5,branches:1,recordsPerMonth:2,reason});
  t1=await Tenant.findById(first.tenant._id).lean();
  const operator={id:String(new mongoose.Types.ObjectId()),role:'Mobile Money Operator',permissions:['mobile_money.view','mobile_money.cash_in'],
    allowedModules:['mobile_money'],branchId:String(first.branch._id)};
    await require('../src/tenant/models').tenantUserModel(first.conn).create({_id:operator.id,name:'Persisted integration operator',email:`operator-${nonce}@example.invalid`,passwordHash:'unused-integration-password',role:operator.role,branchId:operator.branchId,allowedModules:['mobile_money'],status:'active',authVersion:0});
  const input=(reference)=>({customer:'Integration customer',network:'MTN',networkReference:reference,currency:'UGX',amount:'1000',fee:'10',
    idempotencyKey:crypto.randomUUID()});
  const shift=await cash.open(first.conn,t1,operator,{openingCash:'0'});
  await cash.decideOpening(first.conn,t1,owner,String(shift._id),{decision:'approve',note:'Independent opening cash count for module quota integration'});
  await mobile.recordMobileMoney(first.conn,operator,input('MM-TEST-101'),'cash_in',t1);
  await mobile.recordMobileMoney(first.conn,operator,input('MM-TEST-102'),'cash_in',t1);
  await assert.rejects(mobile.recordMobileMoney(first.conn,operator,input('MM-TEST-103'),'cash_in',t1),e=>e.status===429);
  assert.equal(await mobileTransactionModel(first.conn).countDocuments(),2);
  const full=await reports.generate(first.conn,t1,{...reportUser,allowedModules:['reports','mobile_money']},{source:'all'});
  assert(full.sources.some(s=>s.key==='mobile_money'));assert(full.rows.some(r=>r.module==='Mobile Money'));
  const limited=await reports.generate(first.conn,t1,{...reportUser,allowedModules:['reports']},{source:'all'});
  assert(!limited.rows.some(r=>r.module==='Mobile Money'),'report source requires staff assignment');
  await assert.rejects(reports.generate(first.conn,t1,{...reportUser,allowedModules:['reports']},{source:'mobile_money'}),e=>e.status===403);
  await moduleSvc.revokeModule(String(first.tenant._id),admin,{moduleKey:'mobile_money',reason:'Controlled module revocation verifying report independence and no stale access.'});
  t1=await Tenant.findById(first.tenant._id).lean();
  assert(!hasModule(t1,'mobile_money'));assert(hasModule(t1,'reports'));
  await assert.rejects(mobile.recordMobileMoney(first.conn,operator,input('MM-TEST-104'),'cash_in',t1),e=>e.status===403);
  const after=await reports.generate(first.conn,t1,reportUser,{source:'workspace'});
  assert(after.rows.some(r=>r.activity==='branch.created'));
  console.log('PASS: manual request, audited independent subscription, Reports-only access, cross-tenant isolation, per-module quota, staff source scope, revocation and surviving standalone reporting');
 }finally{
  for(const {tenant} of tenants){
   await Promise.all([Request.deleteMany({tenantId:tenant._id}),Audit.deleteMany({recordId:String(tenant._id)}),UsageCounter.deleteMany({tenantId:tenant._id}),Tenant.deleteOne({_id:tenant._id})]);
  }
  for(const slug of slugs)if(/^probe-module-(other-)?[a-f0-9]{16}$/.test(slug)){
   try{await getTenantConnection(slug).db.dropDatabase();}catch(e){console.error('Scratch database cleanup issue:',e.message);}
  }
  await mongoose.disconnect();
 }
}
main().catch(e=>{console.error('MODULE INTEGRATION FAILED:',e.message);process.exitCode=1;mongoose.disconnect().catch(()=>{});});
