#!/usr/bin/env node
'use strict';
// Destructive integration verification. Isolated loopback replica set ONLY.
// Names are random and pre-scoped; scratch resources are deleted on exit.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const env=require('../src/config/env');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const Tenant=require('../src/platform/models/Tenant');
const {plans}=require('../src/data/store');
const {permissionsFor}=require('../src/config/roles');
const {ensureTenantIndexes,branchModel,approvalPolicyModel,approvalRequestModel,auditEventModel}=require('../src/tenant/models');
const approvals=require('../src/tenant/services/approvals.service');
function localOnly(){
 if(env.nodeEnv==='production')throw Error('Approval integration cannot run in production');
 const u=new URL(env.mongoPlatformUri);
 if(u.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.host.includes(','))
  throw Error('An isolated loopback replica set is mandatory');
}
async function main(){
 localOnly();await connectPlatformMongo();verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Tenant.createIndexes();
 const nonce=crypto.randomBytes(8).toString('hex');const slugs=[`probe-approval-a-${nonce}`,`probe-approval-b-${nonce}`];
 const ownerId=String(new mongoose.Types.ObjectId()),requesterId=String(new mongoose.Types.ObjectId()),officerId=String(new mongoose.Types.ObjectId());
 const rows=[];const now=new Date(),past=new Date(now.getTime()-86400000),future=new Date(now.getTime()+7*86400000);
 const snap=plans.find(p=>p.code==='modular');
 try{
  for(let i=0;i<2;i++){
   const slug=slugs[i],conn=getTenantConnection(slug);await ensureTenantIndexes(conn);
   const branch=await branchModel(conn).create({name:'Approval test branch',code:'approval',currency:'UGX',createdBy:ownerId,updatedBy:ownerId});
   const tenant=await Tenant.create({name:`Approval test ${i}`,slug,dbName:`classicfin_tenant_${slug.replace(/-/g,'_')}_db`,
    email:`approval-${i}-${nonce}@example.invalid`,owner:'Test Owner',plan:'modular',status:'active',setupStatus:'complete',
    seatsReserved:1,branchCount:1,enabledModules:[],subscription:{planCode:'modular',planVersion:1,planName:snap.name,
     currency:'USD',priceMonthlyMinor:0,priceYearlyMinor:0,modules:[],limits:snap.limits,generation:1,status:'granted',
     periodStart:past,periodEnd:future,source:'manual_admin_grant'},
    moduleGrants:[{moduleKey:'approval_workflows',status:'granted',generation:1,periodStart:past,periodEnd:future,
     currency:'USD',priceMonthlyMinor:5900,limits:{users:5,branches:1,recordsPerMonth:0}}]});
   rows.push({conn,tenant,branch});
  }
  const [a,b]=rows,branchId=String(a.branch._id);
  const owner={id:ownerId,role:'Tenant Owner',permissions:permissionsFor('Tenant Owner'),branchId,
   allowedModules:['approval_workflows']};
  const requester={id:requesterId,role:'Approval Requester',permissions:permissionsFor('Approval Requester'),branchId,
   allowedModules:['approval_workflows']};
  const officer={id:officerId,role:'Approval Officer',permissions:permissionsFor('Approval Officer'),branchId,
   allowedModules:['approval_workflows']};
  const policy={code:'purchase_review',name:'Branch Procurement',category:'procurement',
   steps:['Approval Officer','Tenant Owner'],expiresHours:48};
  const published=await approvals.publish(a.conn,a.tenant,owner,policy);assert.equal(published.version,1);
  const input={policyCode:policy.code,subject:'Procure laptops',justification:'Replace obsolete laptops required for the branch',idempotencyKey:crypto.randomUUID()};
  const created=await approvals.create(a.conn,a.tenant,requester,input);assert.equal(created.request.status,'pending');
  const replay=await approvals.create(a.conn,a.tenant,requester,input);assert.equal(replay.duplicate,true);
  await assert.rejects(approvals.create(a.conn,a.tenant,requester,{...input,subject:'Different request'}),e=>e.status===409);
  await assert.rejects(approvals.decide(a.conn,a.tenant,requester,String(created.request._id),
   {decision:'approve',note:'Attempting to approve own internal request'}),e=>e.status===403);
  await assert.rejects(approvals.decide(a.conn,a.tenant,{...officer,branchId:String(b.branch._id)},String(created.request._id),
   {decision:'approve',note:'Attempting review in wrong tenant branch'}),e=>e.status===404);
  await assert.rejects(approvals.detail(b.conn,b.tenant,{...requester,branchId:String(b.branch._id)},String(created.request._id)),e=>e.status===404);
  const step1=await approvals.decide(a.conn,a.tenant,officer,String(created.request._id),
   {decision:'approve',note:'Equipment specifications and budget independently checked'});
  assert.equal(step1.status,'pending');assert.equal(step1.currentStep,1);assert.equal(step1.decisions.length,1);
  await assert.rejects(approvals.decide(a.conn,a.tenant,officer,String(created.request._id),
   {decision:'approve',note:'An already approved stage cannot be repeated'}),e=>e.status===409);
  const finalized=await approvals.decide(a.conn,a.tenant,owner,String(created.request._id),
   {decision:'approve',note:'Tenant administration confirms internal purchase approval'});
  assert.equal(finalized.status,'approved');assert.equal(finalized.decisions.length,2);
  await assert.rejects(approvals.cancel(a.conn,a.tenant,requester,String(created.request._id),
   {note:'Trying to cancel an approved request'}),e=>e.status===409);
  const latest=await approvals.publish(a.conn,a.tenant,owner,{...policy,name:'Updated Procurement',steps:['Tenant Owner']});
  assert.equal(latest.version,2);
  const original=await approvals.detail(a.conn,a.tenant,requester,String(created.request._id));
  assert.equal(original.policyVersion,1);assert.deepEqual(original.steps,['Approval Officer','Tenant Owner']);
  const second=await approvals.create(a.conn,a.tenant,requester,{...input,subject:'Another procurement',idempotencyKey:crypto.randomUUID()});
  assert.equal(second.request.policyVersion,2);
  await approvalRequestModel(a.conn).collection.updateOne({_id:second.request._id},{$set:{expiresAt:past}});
  await assert.rejects(approvals.decide(a.conn,a.tenant,owner,String(second.request._id),
   {decision:'approve',note:'Cannot approve expired internal request'}),e=>e.status===409);
  assert.equal(await approvals.expireDue(a.conn),1);
  assert.equal((await approvals.detail(a.conn,a.tenant,requester,String(second.request._id))).status,'expired');
  const report=await require('../src/tenant/reporting/adapters/approvals').rows({conn:a.conn,dateRange:{$gte:past,$lt:future},scope:{branchId}});
  assert(report.some(x=>x.status==='approved'&&x.count===1));assert(report.some(x=>x.status==='expired'&&x.count===1));
  assert.equal(await approvalRequestModel(b.conn).countDocuments(),0);
  assert.equal(await auditEventModel(a.conn).countDocuments({action:'approvals.request.approved'}),1);
  console.log('PASS: Approval policies, version snapshots, idempotency, independent decisions, tenant scope, expiry, audit and reports');
 }finally{
  for(const slug of slugs){if(!/^probe-approval-[ab]-[a-f0-9]{16}$/.test(slug))throw Error('Unsafe test database slug');
   try{await getTenantConnection(slug).db.dropDatabase();}catch(e){console.error('Scratch cleanup:',e.message);process.exitCode=1;}}
  for(const row of rows){await Tenant.deleteOne({_id:row.tenant._id,slug:row.tenant.slug});}
  await mongoose.disconnect();
 }
}
main().catch(e=>{console.error('APPROVAL INTEGRATION FAILED:',e.stack||e.message);process.exitCode=1;mongoose.disconnect().catch(()=>{});});
