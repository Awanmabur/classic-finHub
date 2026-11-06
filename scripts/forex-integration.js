#!/usr/bin/env node
'use strict';
// DESTRUCTIVE SCRATCH TEST. Use only an isolated loopback MongoDB replica set;
// scratch tenant databases and their platform metadata are deleted on exit.
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
const {ensureTenantIndexes,branchModel,forexRateModel,forexQuoteModel,auditEventModel}=require('../src/tenant/models');
const forex=require('../src/tenant/services/forex.service');
function localOnly(){
 if(env.nodeEnv==='production')throw Error('Forex integration cannot run in production');
 const u=new URL(env.mongoPlatformUri);
 if(u.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.host.includes(','))
  throw Error('Isolated loopback MongoDB replica set required');
}
async function main(){
 localOnly();await connectPlatformMongo();verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),UsageCounter.createIndexes()]);
 const nonce=crypto.randomBytes(8).toString('hex'),slugs=[`probe-fx-a-${nonce}`,`probe-fx-b-${nonce}`];
 const ownerId=String(new mongoose.Types.ObjectId()),reviewerId=String(new mongoose.Types.ObjectId());
 const scratch=[],snapshot=plans.find(p=>p.code==='modular'),now=new Date(),past=new Date(now.getTime()-86400000),future=new Date(now.getTime()+7*86400000);
 try{
  for(let i=0;i<2;i++){
   const slug=slugs[i],conn=getTenantConnection(slug);await ensureTenantIndexes(conn);
   const branch=await branchModel(conn).create({name:'Forex scratch branch',code:'fxtest',currency:'UGX',createdBy:ownerId,updatedBy:ownerId});
   const tenant=await Tenant.create({name:`Forex scratch ${i}`,slug,dbName:`classicfin_tenant_${slug.replace(/-/g,'_')}_db`,
    email:`fx-${i}-${nonce}@example.invalid`,owner:'Scratch User',plan:'modular',status:'active',setupStatus:'complete',
    seatsReserved:1,branchCount:1,enabledModules:[],subscription:{planCode:'modular',planVersion:1,planName:snapshot.name,
    currency:'USD',priceMonthlyMinor:0,priceYearlyMinor:0,modules:[],limits:snapshot.limits,generation:1,status:'granted',
    periodStart:past,periodEnd:future,source:'manual_admin_grant'},
    moduleGrants:[{moduleKey:'forex',status:'granted',generation:1,periodStart:past,periodEnd:future,
      currency:'USD',priceMonthlyMinor:11900,limits:{users:5,branches:1,recordsPerMonth:3}}]});
   scratch.push({conn,tenant,branch});
  }
  const [a,b]=scratch;
  const maker={id:ownerId,role:'Forex Operator',branchId:String(a.branch._id),allowedModules:['forex'],permissions:permissionsFor('Forex Operator')};
  const reviewer={id:reviewerId,role:'Reconciliation Officer',branchId:String(a.branch._id),allowedModules:['forex'],permissions:permissionsFor('Reconciliation Officer')};
  const User=require('../src/tenant/models').tenantUserModel(a.conn);
  await User.create([{_id:maker.id,name:'Persisted financial operator',email:`operator-${nonce}@example.invalid`,passwordHash:'unused-integration-password',role:maker.role,branchId:maker.branchId,allowedModules:['forex'],authVersion:0},{_id:reviewer.id,name:'Persisted financial reviewer',email:`reviewer-${nonce}@example.invalid`,passwordHash:'unused-integration-password',role:reviewer.role,branchId:reviewer.branchId,allowedModules:['forex'],authVersion:0}]);
  const rateInput={branchId:String(a.branch._id),fromCurrency:'UGX',toCurrency:'USD',rateDecimal:'0.000275',validHours:24,
   note:'Authorized indicative rate proposed from an external observation'};
  const first=await forex.proposeRate(a.conn,a.tenant,maker,rateInput);
  assert.equal(first.status,'pending_review');
  await assert.rejects(forex.decideRate(a.conn,a.tenant,{...maker,role:'Tenant Owner',permissions:['*']},String(first._id),
   {decision:'approve',note:'A maker must not review own rate'}),e=>e.status===403);
  await User.updateOne({_id:maker.id},{$set:{role:'Tenant Owner'}});
  await assert.rejects(forex.decideRate(a.conn,a.tenant,{...maker,role:'Tenant Owner',permissions:['*']},String(first._id),
   {decision:'approve',note:'A maker must not review own rate'}),e=>e.status===409);
  await User.updateOne({_id:maker.id},{$set:{role:maker.role}});
  const active=await forex.decideRate(a.conn,a.tenant,reviewer,String(first._id),
   {decision:'approve',note:'Independent rate approval, not external price verification'});
  assert.equal(active.status,'active');
  await assert.rejects(forex.decideRate(a.conn,a.tenant,reviewer,String(first._id),
   {decision:'approve',note:'Repeat approval must fail'}),e=>e.status===409);
  const quoteInput=()=>({branchId:String(a.branch._id),rateId:String(active._id),customerLabel:'Scratch customer',
   customerPhone:'+256700123456',identityDocument:'FX-DOC',commission:'0.10',settlementMethod:'Bank settlement',rateSource:'Internal rate board',externalReference:'FX-SLIP',amount:'20000',validMinutes:15,note:'Indicative quote with no currency execution',operation:'buy',idempotencyKey:crypto.randomUUID()});
  const input=quoteInput(),created=await forex.createQuote(a.conn,a.tenant,maker,input);
  assert.equal(created.quote.status,'quoted');assert.equal(created.quote.targetMinor.toString(),'550');
  assert.equal(created.quote.operation,'buy');assert.equal(created.quote.capture.commission,'0.1');assert.equal(created.quote.capture.externalReference,'FX-SLIP');
  await assert.rejects(forex.createQuote(a.conn,a.tenant,maker,{...input,commission:'0.2'}),e=>e.status===409);
  const replay=await forex.createQuote(a.conn,a.tenant,maker,input);
  assert.equal(replay.duplicate,true);assert.equal(String(replay.quote._id),String(created.quote._id));
  await assert.rejects(forex.createQuote(a.conn,a.tenant,maker,{...input,amount:'30000'}),e=>e.status===409);
  await assert.rejects(forex.createQuote(a.conn,a.tenant,maker,{...input,operation:'sell'}),e=>e.status===409);
  await assert.rejects(forex.createQuote(b.conn,b.tenant,maker,quoteInput()),e=>e.status===403);
  await assert.rejects(forex.detail(b.conn,b.tenant,{...maker,branchId:String(b.branch._id)},String(created.quote._id)),e=>e.status===404);
  await assert.rejects(forex.decideQuote(a.conn,a.tenant,{...maker,role:'Tenant Owner',permissions:['*']},String(created.quote._id),
   {decision:'approve',note:'Attempt to self-approve a customer quote'}),e=>e.status===403);
  await User.updateOne({_id:maker.id},{$set:{role:'Tenant Owner'}});
  await assert.rejects(forex.decideQuote(a.conn,a.tenant,{...maker,role:'Tenant Owner',permissions:['*']},String(created.quote._id),
   {decision:'approve',note:'Attempt to self-approve a customer quote'}),e=>e.status===409);
  await User.updateOne({_id:maker.id},{$set:{role:maker.role}});
  const approved=await forex.decideQuote(a.conn,a.tenant,reviewer,String(created.quote._id),
   {decision:'approve',note:'Internal quote approved; execution unavailable'});
  assert.equal(approved.status,'approved_pending_execution');
  const nextRate=await forex.proposeRate(a.conn,a.tenant,maker,{...rateInput,rateDecimal:'0.000280'});
  await forex.decideRate(a.conn,a.tenant,reviewer,String(nextRate._id),
   {decision:'approve',note:'Later rate supersedes earlier rate for new quotations'});
  assert.equal((await forex.detail(a.conn,a.tenant,maker,String(created.quote._id))).rateDecimal,'0.000275');
  assert.equal((await forexRateModel(a.conn).findById(first._id)).status,'superseded');
  const second=await forex.createQuote(a.conn,a.tenant,maker,{...quoteInput(),rateId:String(nextRate._id)});
  const cancelled=await forex.cancelQuote(a.conn,a.tenant,maker,String(second.quote._id),
   {note:'Customer declined the internal quote before execution'});
  assert.equal(cancelled.status,'cancelled');
  const third=await forex.createQuote(a.conn,a.tenant,maker,{...quoteInput(),rateId:String(nextRate._id)});
  await forexQuoteModel(a.conn).collection.updateOne({_id:third.quote._id},{$set:{expiresAt:past}});
  await assert.rejects(forex.decideQuote(a.conn,a.tenant,reviewer,String(third.quote._id),
   {decision:'approve',note:'Expired quote may never be approved'}),e=>e.status===409);
  const sweep=await forex.expireDue(a.conn);assert(sweep.expiredQuotes>=1);
  assert.equal((await forex.detail(a.conn,a.tenant,maker,String(third.quote._id))).status,'expired');
  await assert.rejects(forex.createQuote(a.conn,a.tenant,maker,{...quoteInput(),rateId:String(nextRate._id)}),e=>e.status===429);
  assert.equal(await forexQuoteModel(b.conn).countDocuments(),0);
  assert.equal(await auditEventModel(a.conn).countDocuments({action:'forex.quote.created'}),3);
  const reports=await forex.reportRows({conn:a.conn,filters:{},scope:{branchId:String(a.branch._id)}});
  assert(reports.some(r=>r.status==='approved_pending_execution'&&r.count===1));
  assert(reports.some(r=>r.status==='cancelled'&&r.count===1));
  console.log('PASS: Forex rate approvals, rate supersession, exact quote snapshots, idempotency, quota, review, expiry, reports and tenant isolation');
 }finally{
  for(const slug of slugs){if(!/^probe-fx-[ab]-[a-f0-9]{16}$/.test(slug))throw Error('Unsafe scratch slug');
   try{await getTenantConnection(slug).db.dropDatabase();}catch(e){console.error('Scratch cleanup:',e.message);process.exitCode=1;}}
  for(const row of scratch){await UsageCounter.deleteMany({tenantId:row.tenant._id});await Tenant.deleteOne({_id:row.tenant._id,slug:row.tenant.slug});}
  await mongoose.disconnect();
 }
}
main().catch(e=>{console.error('FOREX INTEGRATION FAILED:',e.stack||e.message);process.exitCode=1;mongoose.disconnect().catch(()=>{});});
