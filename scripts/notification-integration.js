#!/usr/bin/env node
'use strict';
// Destructive test limited to random, isolated loopback MongoDB databases.
// No email is sent to the internet; provider acceptance is stubbed and verified.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const env=require('../src/config/env');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const Tenant=require('../src/platform/models/Tenant');
const {plans}=require('../src/data/store');
const {permissionsFor}=require('../src/config/roles');
const models=require('../src/tenant/models');
const notice=require('../src/tenant/services/notification.service');
function assertLocal(){
 if(env.nodeEnv==='production')throw Error('Notification integration cannot run in production');
 const uri=new URL(env.mongoPlatformUri);
 if(uri.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(uri.hostname)||uri.host.includes(','))
  throw Error('Only an isolated loopback MongoDB replica set is permitted');
}
async function main(){
 assertLocal();await connectPlatformMongo();verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 const nonce=crypto.randomBytes(8).toString('hex');const slugs=[`probe-notify-a-${nonce}`,`probe-notify-b-${nonce}`];
 const ownerId=new mongoose.Types.ObjectId(),recipientId=new mongoose.Types.ObjectId(),managerId=new mongoose.Types.ObjectId();
 const plan=plans.find(p=>p.code==='enterprise');const now=new Date();
 const rows=[];
 try{
  for(const slug of slugs){
   const conn=getTenantConnection(slug);await models.ensureTenantIndexes(conn);
   const branch=await models.branchModel(conn).create({name:'Test branch',code:'notifs',currency:'UGX',createdBy:ownerId,updatedBy:ownerId});
   const tenant=await Tenant.create({name:`Notification Test ${slug}`,slug,dbName:`classicfin_tenant_${slug.replace(/-/g,'_')}_db`,
    owner:'Owner',email:`${slug}@example.invalid`,plan:'enterprise',status:'active',setupStatus:'complete',
    seatsReserved:3,branchCount:1,enabledModules:['notifications','reports'],
    subscription:{planCode:'enterprise',planVersion:1,planName:plan.name,status:'granted',source:'manual_admin_grant',
      currency:'USD',priceMonthlyMinor:49900,priceYearlyMinor:499000,periodStart:new Date(now.getTime()-86400000),
      periodEnd:new Date(now.getTime()+7*86400000),generation:1,modules:['notifications','reports'],limits:plan.limits}});
   rows.push({conn,tenant,branch});
  }
  const a=rows[0],b=rows[1],branchId=String(a.branch._id);
  await models.tenantUserModel(a.conn).insertMany([
   {_id:ownerId,name:'Owner',email:`owner-${nonce}@example.invalid`,passwordHash:'integration-only',role:'Tenant Owner',status:'active'},
   {_id:recipientId,name:'Recipient',email:`recipient-${nonce}@example.invalid`,passwordHash:'integration-only',role:'Mobile Money Operator',
     branchId,allowedModules:['notifications'],status:'active'},
   {_id:managerId,name:'Manager',email:`manager-${nonce}@example.invalid`,passwordHash:'integration-only',role:'Branch Manager',
     branchId,allowedModules:['notifications'],status:'active'}
  ]);
  const owner={id:String(ownerId),name:'Owner',role:'Tenant Owner',permissions:permissionsFor('Tenant Owner')};
  const recipient={id:String(recipientId),name:'Recipient',role:'Mobile Money Operator',branchId,
   allowedModules:['notifications'],permissions:permissionsFor('Mobile Money Operator')};
  const manager={id:String(managerId),name:'Manager',role:'Branch Manager',branchId,
   allowedModules:['notifications'],permissions:permissionsFor('Branch Manager')};
  await notice.setPreference(a.conn,a.tenant,recipient,{emailOptIn:'on'});
  const template={code:'staff_update',name:'Staff Update',subject:'Hello {{recipient_name}}',
   body:'A message from {{sender_name}} at {{tenant_name}}.',emailAvailable:'on'};
  const first=await notice.publish(a.conn,a.tenant,owner,template);assert.equal(first.version,1);
  assert.equal((await notice.publish(a.conn,a.tenant,owner,{...template,name:'New version'})).version,2);
  const payload={recipientId:String(recipientId),templateCode:'staff_update',idempotencyKey:crypto.randomUUID()};
  const delivered=await notice.send(a.conn,a.tenant,owner,payload);assert.equal(delivered.duplicate,false);
  assert.equal(delivered.message.templateVersion,2);assert.equal(delivered.message.emailState,'pending');
  assert.equal((await notice.send(a.conn,a.tenant,owner,payload)).duplicate,true);
  await assert.rejects(notice.send(a.conn,a.tenant,owner,{...payload,recipientId:String(managerId)}),e=>e.status===409);
  await assert.rejects(notice.detail(b.conn,b.tenant,recipient,String(delivered.message._id)),e=>e.status===404);
  assert.equal((await notice.inbox(a.conn,a.tenant,recipient)).items.length,1);
  await notice.markRead(a.conn,a.tenant,recipient,String(delivered.message._id));
  assert((await notice.detail(a.conn,a.tenant,recipient,String(delivered.message._id))).readAt);
  let emails=0;
  const accepted=await notice.processOne(a.conn,a.tenant,'integration-notify',async ({to,idempotencyKey})=>{
   assert.match(to,/@example\.invalid$/);assert(idempotencyKey.includes(String(delivered.message._id)));emails++;
   return {status:'accepted',messageId:'mock-accepted-id'};
  });
  assert.equal(accepted.state,'accepted');assert.equal(emails,1);
  assert.equal((await notice.processOne(a.conn,a.tenant,'integration-notify',async()=>{throw Error('No pending job');})),null);
  // Opt-out must suppress an already queued attempt without contacting the provider.
  const pending=await notice.send(a.conn,a.tenant,owner,{...payload,idempotencyKey:crypto.randomUUID()});
  assert.equal(pending.message.emailState,'pending');
  await notice.setPreference(a.conn,a.tenant,recipient,{emailOptIn:'off'});
  const suppressed=await notice.processOne(a.conn,a.tenant,'integration-notify',async()=>{throw Error('Opt-out ignored');});
  assert.equal(suppressed.state,'suppressed');
  await assert.rejects(notice.send(a.conn,a.tenant,{...manager,branchId:String(b.branch._id)},
   {...payload,idempotencyKey:crypto.randomUUID()}),e=>e.status===403);
  const agg=await require('../src/tenant/reporting/adapters/notifications').rows({conn:a.conn,
   dateRange:{$gte:new Date(now.getTime()-86400000),$lt:new Date(now.getTime()+86400000)},scope:{branchId}});
  assert(agg.some(x=>x.status==='accepted'&&x.count===1));
  assert.equal(await models.notificationMessageModel(b.conn).countDocuments({}),0);
  assert((await models.auditEventModel(a.conn).countDocuments({action:'notifications.message.created'}))===2);
  console.log('PASS: Notification templates, immutable versions, inbox, idempotency, email acceptance, opt-out, cross-tenant isolation and reporting');
 }finally{
  for(const slug of slugs){if(!/^probe-notify-[ab]-[a-f0-9]{16}$/.test(slug))throw Error('Unsafe cleanup slug');
   try{await getTenantConnection(slug).db.dropDatabase();}catch(e){console.error('Scratch cleanup:',e.message);process.exitCode=1;}}
  for(const row of rows){await Tenant.deleteOne({_id:row.tenant._id,slug:row.tenant.slug});}
  await mongoose.disconnect();
 }
}
main().catch(e=>{console.error('NOTIFICATION INTEGRATION FAILED:',e.stack||e.message);process.exitCode=1;mongoose.disconnect().catch(()=>{});});
