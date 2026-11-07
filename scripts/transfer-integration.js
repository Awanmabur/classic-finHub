#!/usr/bin/env node
'use strict';
// DESTRUCTIVE SCRATCH TEST, restricted to an isolated localhost MongoDB replica set.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const env=require('../src/config/env');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const Tenant=require('../src/platform/models/Tenant');
const UsageCounter=require('../src/platform/models/UsageCounter');
const {permissionsFor}=require('../src/config/roles');
const {ensureTenantIndexes,branchModel,transferContactModel,transferOrderModel,auditEventModel}=require('../src/tenant/models');
const svc=require('../src/tenant/services/moneyTransfer.service');
const {plans}=require('../src/data/store');
function localOnly(){
 if(env.nodeEnv==='production')throw Error('Never run transfer integration in production');
 const u=new URL(env.mongoPlatformUri);
 if(u.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.host.includes(','))
  throw Error('Transfer integration requires an isolated single-host loopback MongoDB replica set');
}
async function main(){
 localOnly();await connectPlatformMongo();verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),UsageCounter.createIndexes()]);
 const nonce=crypto.randomBytes(8).toString('hex'),slugs=[`probe-transfer-a-${nonce}`,`probe-transfer-b-${nonce}`];
 const tenants=[];
 const ownerId=String(new mongoose.Types.ObjectId()),reviewerId=String(new mongoose.Types.ObjectId());
 const snapshot=plans.find(p=>p.code==='modular');
 const now=new Date(),early=new Date(now.getTime()-86400000),later=new Date(now.getTime()+14*86400000);
 try{
  for(let i=0;i<2;i++){
   const slug=slugs[i],conn=getTenantConnection(slug);await ensureTenantIndexes(conn);
   const branch=await branchModel(conn).create({name:'Scratch Branch',code:'scratch',currency:'UGX',createdBy:ownerId,updatedBy:ownerId});
   const tenant=await Tenant.create({name:`Transfer Scratch ${i}`,slug,dbName:`classicfin_tenant_${slug.replace(/-/g,'_')}_db`,
    email:`transfer-${i}-${nonce}@example.invalid`,owner:'Scratch Owner',plan:'modular',status:'active',setupStatus:'complete',
    seatsReserved:1,branchCount:1,enabledModules:[],subscription:{planCode:'modular',planVersion:1,planName:snapshot.name,
    currency:'USD',priceMonthlyMinor:0,priceYearlyMinor:0,modules:[],limits:snapshot.limits,generation:1,status:'granted',
    periodStart:early,periodEnd:later,source:'manual_admin_grant'},
    moduleGrants:i===0?[{moduleKey:'money_transfer',status:'granted',generation:1,periodStart:early,periodEnd:later,
     currency:'USD',priceMonthlyMinor:8900,limits:{users:5,branches:1,recordsPerMonth:3}}]:[]});
   tenants.push({tenant,conn,branch});
  }
  const [a,b]=tenants;
  const operator={id:ownerId,role:'Money Transfer Operator',permissions:permissionsFor('Money Transfer Operator'),
   allowedModules:['money_transfer'],branchId:String(a.branch._id)};
  const reviewer={id:reviewerId,role:'Reconciliation Officer',permissions:permissionsFor('Reconciliation Officer'),
   allowedModules:['money_transfer'],branchId:String(a.branch._id)};
  const User=require('../src/tenant/models').tenantUserModel(a.conn);
  await User.create([{_id:operator.id,name:'Persisted financial operator',email:`operator-${nonce}@example.invalid`,passwordHash:'unused-integration-password',role:operator.role,branchId:operator.branchId,allowedModules:['money_transfer'],authVersion:0},{_id:reviewer.id,name:'Persisted financial reviewer',email:`reviewer-${nonce}@example.invalid`,passwordHash:'unused-integration-password',role:reviewer.role,branchId:reviewer.branchId,allowedModules:['money_transfer'],authVersion:0}]);
  const sender=await svc.addContact(a.conn,a.tenant,operator,{kind:'sender',branchId:String(a.branch._id),
   fullName:'Sender Scratch',phone:'+256700123456',country:'UG'});
  const beneficiary=await svc.addContact(a.conn,a.tenant,operator,{kind:'beneficiary',branchId:String(a.branch._id),
   fullName:'Recipient Scratch',phone:'+256701234567',country:'UG'});
  const input=()=>({branchId:String(a.branch._id),senderId:String(sender._id),beneficiaryId:String(beneficiary._id),
   amount:'20000',fee:'100',currency:'UGX',validDays:'2',senderDocument:'SENDER-DOC',receiverDocument:'RECEIVER-DOC',transferMethod:'Mobile Money',purpose:'Family support',exchangeRate:'3700.50',idempotencyKey:crypto.randomUUID()});
  const firstInput=input(),first=await svc.createRequest(a.conn,a.tenant,operator,firstInput);
  assert.equal(first.order.status,'requested');assert.equal(first.order.capture.purpose,'Family support');assert.equal(first.order.capture.exchangeRate,'3700.5');assert(!first.duplicate);
  await assert.rejects(svc.createRequest(a.conn,a.tenant,operator,{...firstInput,purpose:'Changed purpose'}),e=>e.status===409);
  const retry=await svc.createRequest(a.conn,a.tenant,operator,firstInput);
  assert(retry.duplicate);assert.equal(String(first.order._id),String(retry.order._id));
  await assert.rejects(svc.createRequest(a.conn,a.tenant,operator,{...firstInput,amount:'50000'}),e=>e.status===409);
  await assert.rejects(svc.createRequest(b.conn,b.tenant,operator,input()),e=>e.status===403);
  await assert.rejects(svc.detail(b.conn,{...b.tenant.toObject(),moduleGrants:a.tenant.moduleGrants},operator,String(first.order._id)),e=>e.status===404);
  await assert.rejects(svc.decide(a.conn,a.tenant,{...operator,role:'Tenant Owner',permissions:['*']},String(first.order._id),
   {decision:'approve',note:'A person cannot approve their own request'}),e=>e.status===403);
  await User.updateOne({_id:operator.id},{$set:{role:'Tenant Owner'}});
  await assert.rejects(svc.decide(a.conn,a.tenant,{...operator,role:'Tenant Owner',permissions:['*']},String(first.order._id),
   {decision:'approve',note:'A person cannot approve their own request'}),e=>e.status===409);
  await User.updateOne({_id:operator.id},{$set:{role:operator.role}});
  const approved=await svc.decide(a.conn,a.tenant,reviewer,String(first.order._id),
   {decision:'approve',note:'Internal request reviewed against the registered contact details'});
  assert.equal(approved.status,'approved_pending_provider');
  await assert.rejects(svc.cancel(a.conn,a.tenant,operator,String(first.order._id),{note:'Already approved, cannot undo request'}),e=>e.status===409);
  const update=await svc.updateContact(a.conn,a.tenant,operator,String(beneficiary._id),{kind:'beneficiary',
   fullName:'Updated Recipient',phone:'+256799999999',country:'UG'});
  assert.equal(update.fullName,'Updated Recipient');
  assert.equal((await svc.detail(a.conn,a.tenant,operator,String(first.order._id))).beneficiary.name,'Recipient Scratch',
   'historical identity snapshots are immutable after a contact edit');
  const second=await svc.createRequest(a.conn,a.tenant,operator,input());
  const cancelled=await svc.cancel(a.conn,a.tenant,operator,String(second.order._id),{note:'Sender requested cancellation before review'});
  assert.equal(cancelled.status,'cancelled');
  const third=await svc.createRequest(a.conn,a.tenant,operator,input());
  assert.equal(third.order.status,'requested');
  await assert.rejects(svc.createRequest(a.conn,a.tenant,operator,input()),e=>e.status===429,'atomic monthly quota');
  await transferOrderModel(a.conn).collection.updateOne({_id:third.order._id},{$set:{expiresAt:early}});
  await assert.rejects(svc.decide(a.conn,a.tenant,reviewer,String(third.order._id),
   {decision:'approve',note:'Request has expired and must not be approved'}),e=>e.status===409);
  const expiry=await svc.expireDue(a.conn,new Date());assert(expiry.expired>=1);
  assert.equal((await svc.detail(a.conn,a.tenant,operator,String(third.order._id))).status,'expired');
  const report=await svc.reportRows({conn:a.conn,filters:{},scope:{branchId:String(a.branch._id)}});
  assert(report.some(r=>r.status==='approved_pending_provider'&&r.count===1));
  assert(report.some(r=>r.status==='cancelled'&&r.count===1));
  assert.equal(await transferOrderModel(b.conn).countDocuments(),0);
  assert.equal(await auditEventModel(a.conn).countDocuments({action:'money_transfer.request.created'}),3);
  assert.equal(await auditEventModel(a.conn).countDocuments({action:'money_transfer.request.expired'}),1);
  const results=await svc.list(a.conn,a.tenant,operator);
  assert.equal(results.items.length,3);

  // A new branch has no saved contacts. Direct teller entry must remain usable
  // while retaining the same branch, fresh authorization and atomic audit fences.
  await Tenant.updateOne({_id:a.tenant._id},{$set:{'moduleGrants.0.limits.recordsPerMonth':10}});
  const walkInBranch=await branchModel(a.conn).create({name:'Walk-in Branch',code:'walkin',currency:'UGX',createdBy:ownerId,updatedBy:ownerId});
  await User.updateOne({_id:operator.id},{$set:{branchId:walkInBranch._id},$inc:{authVersion:1}});
  const teller={...operator,branchId:String(walkInBranch._id),authVersion:1};
  const typedInput=()=>({senderName:'Walk-in Sender',senderPhone:'+256 700 111 222',senderCountry:'UG',
   receiverName:'Direct Receiver',receiverPhone:'+254712345678',receiverCountry:'KE',senderDocument:'WALKIN-S',receiverDocument:'DIRECT-R',
   amount:'15000',fee:'200',currency:'UGX',validDays:'7',transferMethod:'Cash',purpose:'Typed teller entry',idempotencyKey:crypto.randomUUID()});
  const directInput=typedInput(),direct=await svc.createRequest(a.conn,a.tenant,teller,directInput);
  assert.equal(direct.order.partyEntryMode,'typed');assert.equal(String(direct.order.branchId),teller.branchId);
  assert.equal(direct.order.sender.contactId,null);assert.equal(direct.order.beneficiary.contactId,null);
  assert.equal(direct.order.sender.name,'Walk-in Sender');assert.equal(direct.order.sender.phone,'+256700111222');
  assert.equal(direct.order.beneficiary.name,'Direct Receiver');assert.equal(direct.order.beneficiary.country,'KE');
  assert.equal(direct.order.capture.receiverDocument,'DIRECT-R');
  assert.equal(await transferContactModel(a.conn).countDocuments({branchId:walkInBranch._id}),0,'typed entry never creates directory contacts');
  const directRetry=await svc.createRequest(a.conn,a.tenant,teller,{...directInput,senderPhone:'+256700111222'});
  assert(directRetry.duplicate);assert.equal(String(directRetry.order._id),String(direct.order._id));
  for(const change of [{senderName:'Another Sender'},{receiverName:'Another Receiver'},{senderPhone:'+256700111223'},
   {receiverPhone:'+254712345679'},{senderCountry:'US'},{receiverCountry:'UG'},{receiverDocument:'CHANGED-R'},{purpose:'Changed instruction'}])
   await assert.rejects(svc.createRequest(a.conn,a.tenant,teller,{...directInput,...change}),e=>e.status===409);
  await assert.rejects(svc.createRequest(a.conn,a.tenant,teller,{...typedInput(),senderId:String(sender._id)}),e=>e.status===400);
  await assert.rejects(svc.createRequest(a.conn,a.tenant,teller,{...typedInput(),branchId:String(a.branch._id)}),e=>e.status===403);
  await assert.rejects(svc.createRequest(a.conn,a.tenant,operator,typedInput()),e=>e.status===403,'stale branch and auth version cannot create');
  await assert.rejects(svc.createRequest(b.conn,b.tenant,teller,typedInput()),e=>e.status===403);

  const Audit=auditEventModel(a.conn),Order=transferOrderModel(a.conn),originalAuditCreate=Audit.create;
  const before={orders:await Order.countDocuments(),audits:await Audit.countDocuments(),
   usage:(await UsageCounter.find({tenantId:a.tenant._id}).lean()).map(row=>[String(row._id),row.quantity]),
   branchRevision:(await branchModel(a.conn).findById(walkInBranch._id).lean()).revision,
   tenantVersion:(await Tenant.findById(a.tenant._id).lean()).__v};
  Audit.create=async()=>{throw Error('Injected direct-transfer audit failure');};
  try{await assert.rejects(svc.createRequest(a.conn,a.tenant,teller,typedInput()),/Injected direct-transfer audit failure/);}
  finally{Audit.create=originalAuditCreate;}
  assert.equal(await Order.countDocuments(),before.orders);assert.equal(await Audit.countDocuments(),before.audits);
  assert.deepEqual((await UsageCounter.find({tenantId:a.tenant._id}).lean()).map(row=>[String(row._id),row.quantity]),before.usage);
  assert.equal((await branchModel(a.conn).findById(walkInBranch._id).lean()).revision,before.branchRevision);
  assert.equal((await Tenant.findById(a.tenant._id).lean()).__v,before.tenantVersion,'fresh authorization locks roll back with the transfer');
  await User.updateOne({_id:teller.id},{$set:{allowedModules:[]}});
  await assert.rejects(svc.createRequest(a.conn,a.tenant,teller,typedInput()),e=>e.status===403,'persisted module revocation defeats stale actor permissions');
  assert.equal(await Order.countDocuments(),before.orders);

  // These states are produced by the separately tested reviewed-funding flow.
  // Both must be legal filters for teller records and history.
  for(const status of ['collected_manual','paid_out_manual']){
   await Order.collection.updateOne({_id:direct.order._id},{$set:{status}});
   assert.equal((await svc.list(a.conn,a.tenant,teller,{status})).items.length,1);
  }
  console.log('PASS: legacy contact compatibility; direct teller identities without saved contacts; immutable normalized snapshots; exact typed retries; changed party/capture conflicts; no mixed modes; branch and tenant isolation; fresh account authorization; atomic quota, audit and authorization rollback; manual status filters; independent approval, expiry and reports');
 }finally{
  for(const slug of slugs){if(!/^probe-transfer-[ab]-[a-f0-9]{16}$/.test(slug))throw Error('Unsafe scratch cleanup slug');
   try{await getTenantConnection(slug).db.dropDatabase();}catch(e){console.error('Scratch cleanup failed:',e.message);process.exitCode=1;}}
  for(const item of tenants){await UsageCounter.deleteMany({tenantId:item.tenant._id});await Tenant.deleteOne({_id:item.tenant._id,slug:item.tenant.slug});}
  await mongoose.disconnect();
 }
}
main().catch(e=>{console.error('TRANSFER INTEGRATION FAILED:',e.stack||e.message);process.exitCode=1;mongoose.disconnect().catch(()=>{});});
