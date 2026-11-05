#!/usr/bin/env node
'use strict';
// DESTRUCTIVE SCRATCH TEST. Only loopback MongoDB replica set; unique databases
// created for this test are deleted at the end. Never use in production.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const env=require('../src/config/env');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const Tenant=require('../src/platform/models/Tenant');
const UsageCounter=require('../src/platform/models/UsageCounter');
const {permissionsFor}=require('../src/config/roles');
const {plans}=require('../src/data/store');
const {ensureTenantIndexes,branchModel,bankReferenceModel,bankingRequestModel,auditEventModel}=require('../src/tenant/models');
const banking=require('../src/tenant/services/banking.service');
function requireLocal(){
 if(env.nodeEnv==='production')throw Error('Banking integration is forbidden in production');
 const u=new URL(env.mongoPlatformUri);
 if(u.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.host.includes(','))
  throw Error('Requires isolated loopback MongoDB replica set');
}
async function main(){
 requireLocal();await connectPlatformMongo();verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),UsageCounter.createIndexes()]);
 const nonce=crypto.randomBytes(8).toString('hex'),slugs=[`probe-bank-a-${nonce}`,`probe-bank-b-${nonce}`];
 const scratch=[],ownerId=String(new mongoose.Types.ObjectId()),reviewerId=String(new mongoose.Types.ObjectId());
 const snapshot=plans.find(x=>x.code==='modular'),now=new Date(),yesterday=new Date(now.getTime()-86400000),future=new Date(now.getTime()+12*86400000);
 try{
  for(let i=0;i<2;i++){
   const slug=slugs[i],conn=getTenantConnection(slug);await ensureTenantIndexes(conn);
   const branch=await branchModel(conn).create({name:'Test branch',code:'banktest',currency:'UGX',createdBy:ownerId,updatedBy:ownerId});
   const tenant=await Tenant.create({name:`Bank Test ${i}`,slug,dbName:`classicfin_tenant_${slug.replace(/-/g,'_')}_db`,
    email:`bank-${i}-${nonce}@example.invalid`,owner:'Scratch Owner',plan:'modular',status:'active',setupStatus:'complete',
    seatsReserved:1,branchCount:1,enabledModules:[],subscription:{planCode:'modular',planVersion:1,planName:snapshot.name,
    currency:'USD',priceMonthlyMinor:0,priceYearlyMinor:0,modules:[],limits:snapshot.limits,generation:1,status:'granted',
    periodStart:yesterday,periodEnd:future,source:'manual_admin_grant'},
    moduleGrants:[{moduleKey:'banking',status:'granted',generation:1,periodStart:yesterday,periodEnd:future,
     currency:'USD',priceMonthlyMinor:12900,limits:{users:5,branches:1,recordsPerMonth:3}}]});
   scratch.push({conn,branch,tenant});
  }
  const [a,b]=scratch;
  const operator={id:ownerId,role:'Banking Operator',branchId:String(a.branch._id),allowedModules:['banking'],permissions:permissionsFor('Banking Operator')};
  const reviewer={id:reviewerId,role:'Reconciliation Officer',branchId:String(a.branch._id),allowedModules:['banking'],permissions:permissionsFor('Reconciliation Officer')};
  const add=(customerName,last4)=>banking.createReference(a.conn,a.tenant,operator,{customerName,institutionName:'Scratch Bank',last4,currency:'UGX',branchId:String(a.branch._id)});
  const source=await add('Customer A','1234'),destination=await add('Customer B','5678');
  const build=()=>({branchId:String(a.branch._id),sourceId:String(source._id),destinationId:String(destination._id),
   kind:'transfer_request',amount:'20000',currency:'UGX',note:'Request for a scheduled manual verification before any bank movement',idempotencyKey:crypto.randomUUID()});
  const input=build(),created=await banking.createRequest(a.conn,a.tenant,operator,input);
  assert.equal(created.order.status,'requested');assert(!created.duplicate);
  const replay=await banking.createRequest(a.conn,a.tenant,operator,input);
  assert.equal(replay.duplicate,true);assert.equal(String(created.order._id),String(replay.order._id));
  await assert.rejects(banking.createRequest(a.conn,a.tenant,operator,{...input,amount:'30000'}),e=>e.status===409);
  await assert.rejects(banking.createRequest(b.conn,b.tenant,operator,build()),e=>e.status===403);
  await assert.rejects(banking.detail(b.conn,b.tenant,{...operator,branchId:String(b.branch._id)},String(created.order._id)),e=>e.status===404);
  await assert.rejects(banking.decide(a.conn,a.tenant,{...operator,role:'Tenant Owner',permissions:['*']},String(created.order._id),
   {decision:'approve',note:'Own request must not be approved by the originator'}),e=>e.status===409);
  const accepted=await banking.decide(a.conn,a.tenant,reviewer,String(created.order._id),
   {decision:'approve',note:'Internal evidence reviewed, bank integration still unavailable'});
  assert.equal(accepted.status,'approved_pending_bank');
  await assert.rejects(banking.decide(a.conn,a.tenant,reviewer,String(created.order._id),
   {decision:'approve',note:'Repeated decision is forbidden by conditional update'}),e=>e.status===409);
  const modified=await banking.updateReference(a.conn,a.tenant,operator,String(source._id),
   {customerName:'Updated Customer',institutionName:'Scratch Bank',last4:'9876',currency:'UGX'});
  assert.equal(modified.last4,'9876');
  assert.equal((await banking.detail(a.conn,a.tenant,operator,String(created.order._id))).source.last4,'1234');
  const second=await banking.createRequest(a.conn,a.tenant,operator,build());
  const cancelled=await banking.cancel(a.conn,a.tenant,operator,String(second.order._id),
   {note:'Customer explicitly withdrew the unfinished bank request'});
  assert.equal(cancelled.status,'cancelled');
  const third=await banking.createRequest(a.conn,a.tenant,operator,build());
  await bankingRequestModel(a.conn).collection.updateOne({_id:third.order._id},{$set:{expiresAt:yesterday}});
  await assert.rejects(banking.decide(a.conn,a.tenant,reviewer,String(third.order._id),
   {decision:'approve',note:'This request expired before external bank execution'}),e=>e.status===409);
  const sweep=await banking.expireDue(a.conn,new Date());assert(sweep.expired>=1);
  assert.equal((await banking.detail(a.conn,a.tenant,operator,String(third.order._id))).status,'expired');
  await assert.rejects(banking.createRequest(a.conn,a.tenant,operator,build()),e=>e.status===429);
  const report=await banking.reportRows({conn:a.conn,filters:{},scope:{branchId:String(a.branch._id)}});
  assert(report.some(r=>r.status==='approved_pending_bank'&&r.count===1));
  assert(report.some(r=>r.status==='cancelled'&&r.count===1));
  assert.equal(await bankingRequestModel(b.conn).countDocuments(),0);
  assert.equal(await auditEventModel(a.conn).countDocuments({action:'banking.request.created'}),3);
  assert.equal(await auditEventModel(a.conn).countDocuments({action:'banking.request.expired'}),1);
  assert.equal(await bankReferenceModel(a.conn).countDocuments(),2);
  assert.equal((await banking.list(a.conn,a.tenant,operator)).items.length,3);
  console.log('PASS: banking requests, idempotency, atomic quotas, independently audited review, edits preserving snapshots, cancellation, reports and cross-tenant isolation');
 }finally{
  for(const slug of slugs){if(!/^probe-bank-[ab]-[a-f0-9]{16}$/.test(slug))throw Error('Unsafe scratch slug');
   try{await getTenantConnection(slug).db.dropDatabase();}catch(e){console.error('Scratch database cleanup failed:',e.message);process.exitCode=1;}}
  for(const row of scratch){await UsageCounter.deleteMany({tenantId:row.tenant._id});await Tenant.deleteOne({_id:row.tenant._id,slug:row.tenant.slug});}
  await mongoose.disconnect();
 }
}
main().catch(e=>{console.error('BANKING INTEGRATION FAILED:',e.stack||e.message);process.exitCode=1;mongoose.disconnect().catch(()=>{});});
