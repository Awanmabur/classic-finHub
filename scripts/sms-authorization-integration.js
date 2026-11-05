#!/usr/bin/env node
'use strict';
// Real committed authorization changes are interleaved after SMS draft claim
// and immediately before the financial service executes. Scratch databases only.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)
  throw Error('SMS authorization integration requires an unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),scratch=`cfh_sms_auth_probe_${nonce}`,slug=`probe-sms-auth-${nonce}`;
configured.pathname='/'+scratch;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
process.env.MFA_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const Tenant=require('../src/platform/models/Tenant'),Device=require('../src/platform/models/SmsDevice'),SmsUsage=require('../src/platform/models/SmsUsage');
const FinancialUsage=require('../src/platform/models/UsageCounter'),models=require('../src/tenant/models');
const capture=require('../src/tenant/services/smsCapture.service'),mobile=require('../src/tenant/services/mobileMoney.service'),cash=require('../src/tenant/services/cashDrawer.service');
let conn,tenantId,User,operatorDoc,owner,branch,shift;
const originalRecord=mobile.recordMobileMoney;
async function tenant(){return Tenant.findById(tenantId).lean();}
async function actor(){return capture.operatorFrom(await User.findById(operatorDoc._id).lean());}
async function receive(enrollment,messageId,receivedAt=new Date().toISOString()){
  const value={messageId,sender:'MTNMOMO',receivedAt,body:`MTN Cash In: UGX 1,000; Fee: UGX 10; Customer: Race Customer; Ref: ${messageId}-${nonce}`};
  const raw=Buffer.from(JSON.stringify(value)),timestamp=String(Math.floor(Date.now()/1000));
  return capture.receive(enrollment.device.deviceId,raw,value,{timestamp,
    signature:crypto.createHmac('sha256',Buffer.from(enrollment.secret,'hex')).update(timestamp+'.').update(raw).digest('hex')});
}
async function enroll(name,autoRecord=false){return capture.enroll(conn,await tenant(),owner,{operatorId:String(operatorDoc._id),name,network:'MTN',allowedSenders:'MTNMOMO',...(autoRecord?{autoRecord:'on'}:{})});}
async function interleave(commit,run){
  let calls=0;
  mobile.recordMobileMoney=async(...args)=>{
    ++calls;
    // Restore before the real operation so a transaction retry is not another
    // administrative action. The mutation below is committed to the real DB.
    mobile.recordMobileMoney=originalRecord;
    await commit();
    return originalRecord(...args);
  };
  try{return await run();}finally{mobile.recordMobileMoney=originalRecord;assert.equal(calls,1,'race must occur after the claimed draft reaches the financial service');}
}
async function assertNoFinancialEffect(label){
  assert.equal(await models.mobileTransactionModel(conn).countDocuments(),0,`${label}: no financial record`);
  const counts=await FinancialUsage.find({tenantId}).lean();
  assert.equal(counts.reduce((sum,row)=>sum+row.quantity,0),0,`${label}: no financial allowance consumed`);
  const current=await models.cashSessionModel(conn).findById(shift._id).lean();
  assert.equal(current.recordCount,0,`${label}: cash record count unchanged`);
  assert.equal(String(current.provisionalMovementMinor),'0',`${label}: cash movement unchanged`);
  assert.equal(await models.auditEventModel(conn).countDocuments({action:'mobile_money.cash_in.recorded'}),0,`${label}: no successful financial audit event`);
}
async function confirmationRace(enrollment,id,commit){
  const accepted=await receive(enrollment,id);assert.equal(accepted.state,'parsed');
  const before=(await SmsUsage.findOne({tenantId})).quantity;
  const currentTenant=await tenant(),operator=await actor(),draft=await capture.getDraft(conn,currentTenant,operator,accepted.id);
  await assert.rejects(interleave(commit,()=>capture.recordDraft(conn,currentTenant,operator,accepted.id,draft.fields)),{status:403});
  const rejected=await models.smsInboxModel(conn).findById(accepted.id).lean();
  assert.equal(rejected.state,'needs_review',`${id}: failed authorization restores the review inbox`);
  assert.equal(rejected.recordId,null,`${id}: no transaction link is claimed`);
  assert.equal((await SmsUsage.findOne({tenantId})).quantity,before,`${id}: recording retry does not consume another SMS unit`);
  await assertNoFinancialEffect(id);
}
async function main(){
  await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
  for(const Model of [Tenant,Device,SmsUsage,FinancialUsage])await Model.createIndexes();
  conn=getTenantConnection(slug);await models.ensureTenantIndexes(conn);User=models.tenantUserModel(conn);
  const ownerDoc=await User.create({name:'SMS Race Owner',email:`owner-${nonce}@example.invalid`,passwordHash:'unused',role:'Tenant Owner'});
  owner={id:String(ownerDoc._id),role:'Tenant Owner',permissions:['*']};
  branch=await models.branchModel(conn).create({name:'SMS Race Branch',code:'race-main',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
  const otherBranch=await models.branchModel(conn).create({name:'Other SMS Branch',code:'race-other',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
  operatorDoc=await User.create({name:'SMS Race Operator',email:`operator-${nonce}@example.invalid`,passwordHash:'unused',role:'Mobile Money Operator',branchId:String(branch._id),allowedModules:['mobile_money','sms_capture']});
  const now=Date.now(),doc=await Tenant.create({name:'SMS Authorization Probe',slug,dbName:conn.name,email:ownerDoc.email,owner:ownerDoc.name,
    plan:'sms_race',status:'active',setupStatus:'complete',branchCount:2,seatsReserved:2,enabledModules:['mobile_money','sms_capture'],
    subscription:{planCode:'sms_race',planVersion:1,planName:'SMS Race',currency:'USD',priceMonthlyMinor:20000,priceYearlyMinor:200000,
      modules:['mobile_money','sms_capture'],limits:{users:3,branches:2,transactionsPerMonth:100,smsPerMonth:100,storageMb:100},
      status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(now-60000),periodEnd:new Date(now+86400000)}});
  tenantId=doc._id;
  shift=await cash.open(conn,await tenant(),await actor(),{openingCash:'0'});
  await cash.decideOpening(conn,await tenant(),owner,String(shift._id),{decision:'approve',note:'Independent opening cash verification for authorization race checks'});
  const first=await enroll('Device revoke race'),second=await enroll('User authorization races');
  const delayedTime=new Date(Date.now()-3600000).toISOString();
  const delayedManual=await receive(second,'delayed-manual-confirmation',delayedTime);
  assert.equal(delayedManual.state,'parsed','a complete delayed SMS is captured without mutating the drawer');
  const beforeDelayedConfirmation=(await SmsUsage.findOne({tenantId})).quantity;
  const delayedTenant=await tenant(),delayedActor=await actor(),delayedDraft=await capture.getDraft(conn,delayedTenant,delayedActor,delayedManual.id);
  await assert.rejects(capture.recordDraft(conn,delayedTenant,delayedActor,delayedManual.id,delayedDraft.fields),{status:409,code:'SMS_SHIFT_MISMATCH'});
  const delayedRejected=await models.smsInboxModel(conn).findById(delayedManual.id).lean();
  assert.equal(delayedRejected.state,'needs_review');assert.equal(delayedRejected.reasonCode,'sms_predates_verified_shift');assert.equal(delayedRejected.recordId,null);
  assert.equal((await SmsUsage.findOne({tenantId})).quantity,beforeDelayedConfirmation,'historical confirmation cannot consume another SMS unit');
  await assertNoFinancialEffect('delayed-manual-confirmation');
  const delayedAutomaticDevice=await enroll('Delayed automatic messages',true),beforeDelayedAuto=(await SmsUsage.findOne({tenantId})).quantity;
  const delayedAutomatic=await receive(delayedAutomaticDevice,'delayed-automatic-confirmation',delayedTime);
  assert.equal(delayedAutomatic.accepted,true);assert.equal(delayedAutomatic.state,'needs_review');
  const delayedAutomaticDraft=await models.smsInboxModel(conn).findById(delayedAutomatic.id).lean();
  assert.equal(delayedAutomaticDraft.reasonCode,'sms_predates_verified_shift');assert.equal(delayedAutomaticDraft.recordId,null);
  assert.equal((await SmsUsage.findOne({tenantId})).quantity,beforeDelayedAuto+1,'a delayed SMS consumes exactly one capture unit');
  await assertNoFinancialEffect('delayed-automatic-confirmation');
  const delayedInboxCount=await models.smsInboxModel(conn).countDocuments();
  await confirmationRace(first,'device-revoked',()=>capture.revoke(conn,{_id:tenantId},owner,first.device.deviceId));
  await confirmationRace(second,'user-disabled',()=>User.updateOne({_id:operatorDoc._id},{$set:{status:'disabled'},$inc:{authVersion:1}}));
  await User.updateOne({_id:operatorDoc._id},{$set:{status:'active'}});
  await confirmationRace(second,'branch-reassigned',()=>User.updateOne({_id:operatorDoc._id},{$set:{branchId:String(otherBranch._id)}}));
  await User.updateOne({_id:operatorDoc._id},{$set:{branchId:String(branch._id)}});
  await confirmationRace(second,'sms-assignment-revoked',()=>User.updateOne({_id:operatorDoc._id},{$set:{allowedModules:['mobile_money']}}));
  await User.updateOne({_id:operatorDoc._id},{$set:{allowedModules:['mobile_money','sms_capture']}});
  await confirmationRace(second,'tenant-sms-revoked',()=>Tenant.updateOne({_id:tenantId},{$set:{enabledModules:['mobile_money']},$inc:{__v:1}}));
  await Tenant.updateOne({_id:tenantId},{$set:{enabledModules:['mobile_money','sms_capture']},$inc:{__v:1}});
  const automatic=await enroll('Automatic revoke race',true);
  const beforeAutomatic=(await SmsUsage.findOne({tenantId})).quantity;
  const result=await interleave(()=>capture.revoke(conn,{_id:tenantId},owner,automatic.device.deviceId),()=>receive(automatic,'automatic-device-revoked'));
  assert.equal(result.accepted,true);assert.equal(result.state,'needs_review','automatic recording must retain a draft when device access is revoked');
  assert.equal((await SmsUsage.findOne({tenantId})).quantity,beforeAutomatic+1,'the accepted SMS consumes exactly one capture unit');
  const automaticDraft=await models.smsInboxModel(conn).findById(result.id).lean();assert.equal(automaticDraft.recordId,null);
  await assertNoFinancialEffect('automatic-device-revoked');
  assert.equal(await models.smsInboxModel(conn).countDocuments(),delayedInboxCount+6,'all denied financial writes preserve their original captured drafts');
  // Positive control: restored, authorized accounts can still use the same
  // independently verified shift. The race guard must not reject every write.
  const allowed=await receive(second,'authorized-positive-control'),currentTenant=await tenant(),currentActor=await actor();
  const allowedDraft=await capture.getDraft(conn,currentTenant,currentActor,allowed.id);
  const recorded=await capture.recordDraft(conn,currentTenant,currentActor,allowed.id,allowedDraft.fields);
  assert.equal(recorded.duplicate,false);assert.equal(recorded.created.entrySource,'sms');
  assert.equal(await models.mobileTransactionModel(conn).countDocuments(),1);
  const finalCash=await models.cashSessionModel(conn).findById(shift._id).lean();
  assert.equal(finalCash.recordCount,1);assert.equal(String(finalCash.provisionalMovementMinor),'1000');
  assert.equal((await FinancialUsage.find({tenantId}).lean()).reduce((sum,row)=>sum+row.quantity,0),1);
  console.log('PASS: delayed SMS cannot enter a newer verified drawer; committed device revoke, user disable/auth-version change, branch reassignment, staff module revoke and tenant module revoke after draft claim prevent financial writes; automatic receive returns review; denied writes preserve cash/quota and authorized positive control succeeds');
}
async function cleanup(){
  mobile.recordMobileMoney=originalRecord;
  if(mongoose.connection.readyState===1&&mongoose.connection.name===scratch&&/^cfh_sms_auth_probe_[a-f0-9]{16}$/.test(scratch)){
    if(conn)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();
  }
  await mongoose.disconnect();
}
main().catch(error=>{console.error('SMS AUTHORIZATION INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(()=>{console.error('SMS authorization scratch cleanup failed');process.exitCode=1;}));
