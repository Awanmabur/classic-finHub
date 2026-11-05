#!/usr/bin/env node
'use strict';
// DESTRUCTIVE SCRATCH INTEGRATION CHECK: loopback MongoDB replica set only.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const env=require('../src/config/env');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const Tenant=require('../src/platform/models/Tenant');
const {plans}=require('../src/data/store');
const {permissionsFor}=require('../src/config/roles');
const {ensureTenantIndexes,branchModel,auditEventModel,forexQuoteModel}=require('../src/tenant/models');
const analytics=require('../src/tenant/services/analytics.service');
const reporting=require('../src/tenant/services/operationsReports.service');
const {hasModule}=require('../src/tenant/services/moduleAccess.service');
function localOnly(){
 if(env.nodeEnv==='production')throw Error('Analytics integration cannot run in production');
 const uri=new URL(env.mongoPlatformUri);
 if(uri.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(uri.hostname)||uri.host.includes(','))
  throw Error('Analytics integration requires an isolated loopback MongoDB replica set');
}
async function main(){
 localOnly();await connectPlatformMongo();verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Tenant.createIndexes();
 const nonce=crypto.randomBytes(8).toString('hex'),slugs=[`probe-analytics-${nonce}`,`probe-analytics-other-${nonce}`];
 const snapshot=plans.find(p=>p.code==='modular');
 const now=new Date(),yesterday=new Date(now);yesterday.setUTCHours(12,0,0,0);yesterday.setUTCDate(yesterday.getUTCDate()-1);
 const previous=new Date(yesterday.getTime()-7*86400000);
 const past=new Date(now.getTime()-86400000),future=new Date(now.getTime()+7*86400000);
 const actorId=new mongoose.Types.ObjectId(),targetId=new mongoose.Types.ObjectId();
 const grants=keys=>keys.map(moduleKey=>({moduleKey,status:'granted',generation:1,periodStart:past,periodEnd:future,
  currency:'USD',priceMonthlyMinor:4900,limits:{users:5,branches:2,recordsPerMonth:0}}));
 const scratch=[];
 try{
  for(let i=0;i<2;i++){
   const slug=slugs[i],conn=getTenantConnection(slug);await ensureTenantIndexes(conn);
   const branch=await branchModel(conn).create({name:'Analytics first branch',code:'first',currency:'UGX',createdBy:actorId,updatedBy:actorId});
   const otherBranch=await branchModel(conn).create({name:'Analytics second branch',code:'second',currency:'UGX',createdBy:actorId,updatedBy:actorId});
   const tenant=await Tenant.create({name:`Analytics Probe ${i}`,slug,dbName:`classicfin_tenant_${slug.replace(/-/g,'_')}_db`,
    email:`analytics-${i}-${nonce}@example.invalid`,owner:'Scratch Owner',plan:'modular',status:'active',setupStatus:'complete',
    seatsReserved:1,branchCount:2,enabledModules:[],subscription:{planCode:'modular',planVersion:1,planName:snapshot.name,
    currency:'USD',priceMonthlyMinor:0,priceYearlyMinor:0,modules:[],limits:snapshot.limits,generation:1,status:'granted',
    periodStart:past,periodEnd:future,source:'manual_admin_grant'},moduleGrants:i===0?grants(['analytics','forex']):[]});
   scratch.push({conn,tenant,branch,otherBranch});
  }
  const [a,b]=scratch;
  const analyst={id:String(actorId),role:'Analytics Analyst',branchId:String(a.branch._id),
   permissions:permissionsFor('Analytics Analyst'),allowedModules:['analytics','forex']};
  const owner={...analyst,role:'Tenant Owner',permissions:['*'],allowedModules:[]};
  const Audit=auditEventModel(a.conn);
  await Audit.create([
   {action:'branch.event.first',actorId,targetId,metadata:{branchId:String(a.branch._id)},createdAt:yesterday},
   {action:'branch.event.previous',actorId,targetId,metadata:{branchId:String(a.branch._id)},createdAt:previous},
   {action:'branch.event.other',actorId,targetId,metadata:{branchId:String(a.otherBranch._id)},createdAt:yesterday}
  ]);
  await auditEventModel(b.conn).create({action:'foreign.event',actorId,targetId,
   metadata:{branchId:String(b.branch._id)},createdAt:yesterday});
  assert(hasModule(a.tenant,'analytics'));assert(!hasModule(a.tenant,'reports'));
  const scoped=await analytics.generate(a.conn,a.tenant,analyst,{days:'7',source:'workspace'},now);
  assert.equal(scoped.data[0].current,1);assert.equal(scoped.data[0].previous,1);
  assert.equal(scoped.workspaceTrend.reduce((total,x)=>total+x.count,0),1);
  const complete=await analytics.generate(a.conn,a.tenant,owner,{days:'7',source:'workspace'},now);
  assert.equal(complete.data[0].current,2,'Tenant Owner can see both own branches');
  assert.deepEqual(reporting.sourcesFor(a.tenant,analyst),[],'Reports not automatically included');
  await assert.rejects(analytics.generate(b.conn,b.tenant,analyst,{days:'7'}),e=>e.status===403);
  // A Forex quote is a record, not a completed currency exchange.
  await forexQuoteModel(a.conn).create({reference:'FX-ANALYTICS-TEST',idempotencyKey:crypto.randomUUID(),
   branchId:a.branch._id,createdBy:actorId,customerLabel:'Scratch customer',rateId:new mongoose.Types.ObjectId(),
   fromCurrency:'UGX',toCurrency:'USD',rateDecimal:'0.000275',sourceMinor:'20000',targetMinor:'550',
   expiresAt:new Date(now.getTime()+86400000),validMinutes:15,note:'Scratch indicative quote for analytics',
   createdAt:yesterday,updatedAt:yesterday});
  const fx=await analytics.generate(a.conn,a.tenant,analyst,{days:'7',source:'forex'},now);
  assert.equal(fx.data.length,1);assert.equal(fx.data[0].current,1);
  assert.equal(fx.data[0].breakdown[0].status,'quoted');
  await assert.rejects(analytics.generate(a.conn,a.tenant,{...analyst,allowedModules:['analytics']},
   {days:'7',source:'forex'},now),e=>e.status===403);
  const withoutForex={...a.tenant.toObject(),moduleGrants:grants(['analytics'])};
  assert.deepEqual(analytics.sourcesFor(withoutForex,analyst).map(s=>s.key),['workspace']);
  assert.equal(reporting.sourcesFor(withoutForex,analyst).length,0);
  assert(analytics.csv(scoped).includes('Workspace activity'));
  console.log('PASS: Analytics-only access, branch and tenant isolation, complete UTC periods, prior-window comparison, optional Forex source, safe report independence and CSV');
 }finally{
  for(const slug of slugs)if(/^probe-analytics-(other-)?[a-f0-9]{16}$/.test(slug)){
   try{await getTenantConnection(slug).db.dropDatabase();}catch(e){console.error('Scratch database cleanup failed',e.message);process.exitCode=1;}
  }
  for(const row of scratch)await Tenant.deleteOne({_id:row.tenant._id,slug:row.tenant.slug});
  await mongoose.disconnect();
 }
}
main().catch(e=>{console.error('ANALYTICS INTEGRATION FAILED:',e.stack||e.message);process.exitCode=1;mongoose.disconnect().catch(()=>{});});
