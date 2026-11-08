#!/usr/bin/env node
'use strict';
// Destructive checks use fresh random scratch databases on a loopback replica set.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)
  throw Error('SMS integration requires an unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),scratch=`cfh_sms_probe_${nonce}`,slug=`probe-sms-${nonce}`;
configured.pathname='/'+scratch;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
process.env.MFA_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');
const mongoose=require('mongoose'),session=require('express-session'),bcrypt=require('bcryptjs');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const Tenant=require('../src/platform/models/Tenant'),Device=require('../src/platform/models/SmsDevice'),Usage=require('../src/platform/models/SmsUsage');
const Identity=require('../src/platform/models/AccountIdentity'),models=require('../src/tenant/models');
const capture=require('../src/tenant/services/smsCapture.service'),cash=require('../src/tenant/services/cashDrawer.service');
const {permissionsFor}=require('../src/config/roles');
let conn,server;
async function main(){
  await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
  for(const Model of [Tenant,Device,Usage,Identity,require('../src/platform/models/UsageCounter')])await Model.createIndexes();
  conn=getTenantConnection(slug);await models.ensureTenantIndexes(conn);
  const User=models.tenantUserModel(conn),ownerDoc=await User.create({name:'SMS Probe Owner',email:`owner-${nonce}@example.invalid`,passwordHash:'unused',role:'Tenant Owner'});
  const owner={id:String(ownerDoc._id),role:'Tenant Owner',permissions:['*']};
  const branch=await models.branchModel(conn).create({name:'SMS Probe Branch',code:'sms-main',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
  const password='Sms-Probe-Only#2026',operatorDoc=await User.create({name:'SMS Probe Operator',email:`operator-${nonce}@example.invalid`,passwordHash:await bcrypt.hash(password,4),
    role:'Mobile Money Operator',branchId:String(branch._id),allowedModules:['mobile_money','sms_capture']});
  const operator={...capture.operatorFrom(operatorDoc.toObject()),permissions:permissionsFor(operatorDoc.role)};
  const now=Date.now(),tenantDoc=await Tenant.create({name:'SMS Probe Tenant',slug,dbName:conn.name,email:ownerDoc.email,owner:ownerDoc.name,plan:'sms_probe',status:'active',setupStatus:'complete',branchCount:1,seatsReserved:2,
    enabledModules:['mobile_money','sms_capture'],subscription:{planCode:'sms_probe',planVersion:1,planName:'SMS Probe',currency:'USD',priceMonthlyMinor:20000,priceYearlyMinor:200000,
      modules:['mobile_money','sms_capture'],limits:{users:3,branches:2,transactionsPerMonth:20,smsPerMonth:8,storageMb:100},status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(now-60000),periodEnd:new Date(now+86400000)}});
  await Identity.create({email:operatorDoc.email,kind:'tenant',accountId:operatorDoc._id,tenantId:tenantDoc._id});
  let tenant=await Tenant.findById(tenantDoc._id).lean();
  const enrolled=await capture.enroll(conn,tenant,owner,{operatorId:operator.id,name:'Integration Android',network:'MTN',allowedSenders:'MTNMOMO',autoRecord:'on'});
  assert.equal(enrolled.secret.length,64);
  const stored=await Device.findOne({deviceId:enrolled.device.deviceId}).select('+secretEncrypted').lean();
  assert(!stored.secretEncrypted.includes(enrolled.secret),'signing credentials encrypted at rest');
  const shift=await cash.open(conn,tenant,operator,{openingCash:'0'});
  await cash.decideOpening(conn,tenant,owner,String(shift._id),{decision:'approve',note:'Independently counted opening cash for SMS capture'});
  server=await new Promise(resolve=>{const listener=require('../src/app')({sessionStore:new session.MemoryStore()}).listen(0,()=>resolve(listener));});
  const base=`http://127.0.0.1:${server.address().port}`,endpoint=`/integrations/sms/${enrolled.device.deviceId}`;
  const payload=(id,body)=>({messageId:id,sender:'MTNMOMO',receivedAt:new Date().toISOString(),body});
  async function deliver(value,{secret=enrolled.secret,timestamp=String(Math.floor(Date.now()/1000)),signature,raw}={}){
    const body=raw||JSON.stringify(value),signed=signature||crypto.createHmac('sha256',Buffer.from(secret,'hex')).update(timestamp+'.'+body).digest('hex');
    const response=await fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-SMS-Timestamp':timestamp,'X-SMS-Signature':signed},body});
    const text=await response.text();return {status:response.status,text,json:response.headers.get('content-type')?.includes('json')?JSON.parse(text):null};
  }
  const first=payload('android-100',`MTN Cash In: UGX 1,000; Fee: UGX 10; Customer: SMS Customer; Ref: SMS-${nonce}`);
  assert.equal((await deliver(first,{secret:'0'.repeat(64)})).status,401);
  assert.equal((await deliver(first,{timestamp:String(Math.floor(Date.now()/1000)-301)})).status,401);
  assert.equal((await deliver({...first,tenantId:String(tenant._id)})).status,400,'clients cannot select tenant');
  assert.equal((await deliver({...first,sender:'UNTRUSTED'})).status,403);
  const accepted=await deliver(first);assert.equal(accepted.status,202,accepted.text);assert.equal(accepted.json.state,'recorded');
  // Exercise the actual Python Android relay's byte/signature protocol against
  // this Node HTTP receiver, without exposing credentials in argv or output.
  const python=require('node:child_process').spawn('python3',['-c',
    'import importlib.util,json,sys,time; from pathlib import Path; p=Path("tools/android-sms-relay/relay.py"); s=importlib.util.spec_from_file_location("relay",p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); d=json.load(sys.stdin); status,accepted=m.send(d["config"],json.dumps(d["payload"],ensure_ascii=False,separators=(",",":")),int(time.time())); print(json.dumps({"status":status,"accepted":accepted}))'],{stdio:['pipe','pipe','pipe']});
  let pythonOutput='';python.stdout.on('data',chunk=>{pythonOutput+=chunk;});python.stderr.resume();
  python.stdin.end(JSON.stringify({config:{endpoint:base+endpoint,secret:enrolled.secret},payload:first}));
  const pythonExit=await new Promise((resolve,reject)=>{python.once('error',reject);python.once('close',resolve);});
  assert.equal(pythonExit,0,'Android relay process completes');assert.deepEqual(JSON.parse(pythonOutput),{status:200,accepted:true},'Python relay signs bytes accepted by the real server and retries remain idempotent');
  const inboxId=accepted.json.id,record=await models.mobileTransactionModel(conn).findOne().lean();
  assert.equal(record.entrySource,'sms');assert.equal(String(record.smsInboxId),inboxId);assert.equal(record.status,'pending_verification');
  assert.equal(String(record.branchId),String(branch._id));assert.equal(String(record.operatorId),operator.id);
  assert.equal((await deliver(first)).json.duplicate,true);assert.equal(await models.mobileTransactionModel(conn).countDocuments(),1);
  assert.equal((await deliver({...first,body:first.body+' changed'})).status,409);
  assert.equal((await Usage.findOne()).quantity,1,'duplicates do not consume quota');
  const unknown=payload('android-101','You received money. Ambiguous operation and missing fee.');
  const captured=await deliver(unknown);assert.equal(captured.status,202);assert.equal(captured.json.state,'needs_review');
  const rawStored=await models.smsInboxModel(conn).findById(captured.json.id).select('+bodyEncrypted').lean();
  assert(!rawStored.bodyEncrypted.includes(unknown.body));
  tenant=await Tenant.findById(tenant._id).lean();
  await assert.rejects(capture.recordDraft(conn,tenant,owner,captured.json.id,{operation:'cash_in'}),{status:403},'owner cannot impersonate device operator');
  const confirmed=await capture.recordDraft(conn,tenant,operator,captured.json.id,{operation:'cash_in',customer:'Reviewed customer',network:'MTN',networkReference:'REVIEW-'+nonce,currency:'UGX',amount:'2000',fee:'0'});
  assert(confirmed.created._id);assert.equal(await models.mobileTransactionModel(conn).countDocuments(),2);
  const noShift=await User.create({name:'No Shift Operator',email:`no-shift-${nonce}@example.invalid`,passwordHash:'unused',role:'Mobile Money Operator',branchId:String(branch._id),allowedModules:['mobile_money','sms_capture']});
  tenant=await Tenant.findById(tenant._id).lean();
  const other=await capture.enroll(conn,tenant,owner,{operatorId:String(noShift._id),name:'No Shift Android',network:'MTN',allowedSenders:'MTNMOMO',autoRecord:'on'});
  const otherValue=payload('no-shift-1',`MTN Cash In: UGX 1,000; Fee: UGX 10; Customer: No Shift; Ref: NOSHIFT-${nonce}`),otherRaw=Buffer.from(JSON.stringify(otherValue)),timestamp=String(Math.floor(Date.now()/1000));
  const failed=await capture.receive(other.device.deviceId,otherRaw,otherValue,{timestamp,signature:crypto.createHmac('sha256',Buffer.from(other.secret,'hex')).update(timestamp+'.').update(otherRaw).digest('hex')});
  assert.equal(failed.state,'needs_review','missing verified cash shift never creates financial record');
  assert.equal(await models.mobileTransactionModel(conn).countDocuments(),2);
  tenant=await Tenant.findById(tenant._id).lean();
  const secondOperator=capture.operatorFrom(noShift.toObject());
  assert.equal(String((await capture.getDraft(conn,tenant,owner,captured.json.id))._id),captured.json.id,'owner may inspect the tenant inbox');
  await assert.rejects(capture.getDraft(conn,tenant,secondOperator,captured.json.id),{status:404},'operators cannot inspect another device operator’s SMS');
  await assert.rejects(capture.getDraft(conn,tenant,operator,failed.id),{status:404},'SMS ownership scope applies in both directions');
  const secondBranch=await models.branchModel(conn).create({name:'SMS Other Branch',code:'sms-other',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
  const viewedInbox=await capture.getInbox(conn,tenant,{...owner,viewBranchId:String(branch._id)});
  assert(viewedInbox.items.some(row=>String(row._id)===captured.json.id),'viewed branch includes its captured SMS');
  const otherInbox=await capture.getInbox(conn,tenant,{...owner,viewBranchId:String(secondBranch._id)});
  assert.equal(otherInbox.items.length,0);assert.equal(otherInbox.devices.length,0);assert.equal(otherInbox.operators.length,0,'SMS management read choices follow the selected branch');
  await assert.rejects(capture.getDraft(conn,tenant,{...owner,viewBranchId:String(secondBranch._id)},captured.json.id),{status:404});
  assert((await capture.getInbox(conn,tenant,{...owner,viewBranchId:'all'})).items.some(row=>String(row._id)===captured.json.id),'All branches retains tenant-wide inbox visibility');
  await User.updateOne({_id:operatorDoc._id},{$set:{branchId:String(secondBranch._id)}});
  try{
    assert.equal((await deliver(payload('branch-mismatch-1','Unrelated transaction message'))).status,403,'reassigned operators cannot deliver through the old branch-bound device');
    assert.equal(await models.smsInboxModel(conn).countDocuments({messageId:'branch-mismatch-1'}),0);
  }finally{await User.updateOne({_id:operatorDoc._id},{$set:{branchId:String(branch._id)}});}
  await User.updateOne({_id:operatorDoc._id},{$set:{allowedModules:['mobile_money']}});
  try{
    assert.equal((await deliver(payload('assignment-revoked-1','Unrelated transaction message'))).status,403,'revoking the SMS staff assignment disables delivery immediately');
    assert.equal(await models.smsInboxModel(conn).countDocuments({messageId:'assignment-revoked-1'}),0);
  }finally{await User.updateOne({_id:operatorDoc._id},{$set:{allowedModules:['mobile_money','sms_capture']}});}
  await Usage.updateOne({tenantId:tenant._id,generation:tenant.subscription.generation},{$set:{quantity:8}});
  const inboxBeforeQuota=await models.smsInboxModel(conn).countDocuments();
  const exhausted=await deliver(payload('quota-exhausted-1','An unknown SMS still requires one capture unit'));
  assert.equal(exhausted.status,429,exhausted.text);
  assert.equal(await models.smsInboxModel(conn).countDocuments(),inboxBeforeQuota,'rejected quota reservation cannot leave a draft');
  assert.equal(await models.smsInboxModel(conn).countDocuments({messageId:'quota-exhausted-1'}),0);
  assert.equal((await Usage.findOne({tenantId:tenant._id})).quantity,8,'failed capture never increments an exhausted quota');
  const fullQuotaDuplicate=await deliver(first);
  assert.equal(fullQuotaDuplicate.status,200,fullQuotaDuplicate.text);assert.equal(fullQuotaDuplicate.json.duplicate,true);
  assert.equal(await models.mobileTransactionModel(conn).countDocuments(),2,'duplicates remain idempotent after the SMS allocation is exhausted');
  const manual=await require('../src/tenant/services/mobileMoney.service').recordMobileMoney(conn,operator,{customer:'Manual customer',network:'MTN',
    networkReference:'MANUAL-'+nonce,currency:'UGX',amount:'500',fee:'0',idempotencyKey:crypto.randomUUID()},'cash_in',tenant);
  assert.equal(manual.created.entrySource,'manual','manual entry stays available independently of the SMS capture quota');
  assert.equal(await models.mobileTransactionModel(conn).countDocuments(),3);
  assert.equal((await Usage.findOne({tenantId:tenant._id})).quantity,8,'manual entry never consumes SMS units');
  // Tenant browser endpoints still require an authenticated account and CSRF.
  let cookie='';
  async function browser(path,fields){const response=await fetch(base+path,{redirect:'manual',method:fields?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(fields?{'content-type':'application/x-www-form-urlencoded'}:{})},...(fields?{body:new URLSearchParams(fields).toString()}:{})});cookie=response.headers.get('set-cookie')?.split(';')[0]||cookie;return {response,html:await response.text()};}
  const signIn=await browser('/signin'),csrf=signIn.html.match(/name="_csrf" value="([a-f0-9]{64})"/)[1];
  const signed=await browser('/signin',{_csrf:csrf,email:operatorDoc.email,password});assert.equal(signed.response.status,303);
  const page=await browser('/tenant/sms-capture');assert.equal(page.response.status,200,page.html);assert.match(page.html,/SMS inbox/);assert.doesNotMatch(page.html,new RegExp(enrolled.secret));
  const forged=await browser(`/tenant/sms-capture/${inboxId}/dismiss`,{note:'Forged browser request'});assert.equal(forged.response.status,403,'tenant writes still require CSRF');
  // Model a process dying after its financial transaction commits but before
  // the inbox link is saved. The persisted fields and stable idempotency key
  // must let the operator recover the original record without consuming quota.
  const FinancialUsage=require('../src/platform/models/UsageCounter');
  const financialBeforeRecovery=await FinancialUsage.findOne({tenantId:tenant._id}).lean();
  await models.smsInboxModel(conn).updateOne({_id:inboxId},{$set:{state:'processing',processingToken:'expired-probe',
    processingUntil:new Date(Date.now()-1),recordId:null}});
  const recovered=await capture.getDraft(conn,tenant,operator,inboxId);
  assert.equal(recovered.state,'needs_review','an expired processing lease must become safely reviewable');
  assert.equal(recovered.reasonCode,'interrupted_recording_retry_safely');
  const retried=await capture.recordDraft(conn,tenant,operator,inboxId,recovered.fields);
  assert.equal(retried.duplicate,true,'recovery reuses the original financial idempotency key');
  assert.equal(String(retried.created._id),String(record._id));
  const relinked=await models.smsInboxModel(conn).findById(inboxId).lean();
  assert.equal(relinked.state,'recorded');assert.equal(String(relinked.recordId),String(record._id));
  assert.equal(await models.mobileTransactionModel(conn).countDocuments(),3,'crash recovery never creates another transaction');
  assert.equal((await Usage.findOne({tenantId:tenant._id})).quantity,8,'crash recovery never consumes another SMS unit');
  assert.equal((await FinancialUsage.findById(financialBeforeRecovery._id)).quantity,financialBeforeRecovery.quantity,'crash recovery never consumes another financial unit');
  await capture.revoke(conn,tenant,owner,enrolled.device.deviceId);
  assert.equal((await deliver(payload('android-102','Another message'))).status,403);
  await User.updateOne({_id:noShift._id},{$set:{status:'disabled'}});
  await assert.rejects(capture.receive(other.device.deviceId,otherRaw,otherValue,{timestamp,signature:crypto.createHmac('sha256',Buffer.from(other.secret,'hex')).update(timestamp+'.').update(otherRaw).digest('hex')}),{status:403});
  assert(await models.auditEventModel(conn).exists({action:'sms.device.revoked'}));
  // A newly published capture allowance leaves one unit for the separate
  // South Sudan device; the existing UGX drawer remains independent.
  await Tenant.updateOne({_id:tenant._id},{$set:{'subscription.limits.smsPerMonth':9}});
  tenant=await Tenant.findById(tenant._id).lean();
  const originalMovement=String((await models.cashSessionModel(conn).findById(shift._id)).provisionalMovementMinor);
  const sspShift=await cash.open(conn,tenant,operator,{currency:'SSP',openingCash:'0.00'});
  await cash.decideOpening(conn,tenant,owner,sspShift._id,{decision:'approve',note:'Independent physical SSP opening count checked separately from the UGX drawer'});
  tenant=await Tenant.findById(tenant._id).lean();
  const ssd=await capture.enroll(conn,tenant,owner,{operatorId:operator.id,name:'MTN South Sudan Android',network:'MTN SSD',allowedSenders:'MTNSSD',autoRecord:'on'});
  const ssdPayload={messageId:'ssd-sspcents-1',sender:'MTNSSD',receivedAt:new Date().toISOString(),body:`MTN SSD Cash In: SSP 1,000.25; Fee: SSP 10.05; Customer: SSP Customer; Ref: SSD-${nonce}`};
  const ssdRaw=Buffer.from(JSON.stringify(ssdPayload)),ssdAt=String(Math.floor(Date.now()/1000));
  const ssdHeaders={timestamp:ssdAt,signature:crypto.createHmac('sha256',Buffer.from(ssd.secret,'hex')).update(ssdAt+'.').update(ssdRaw).digest('hex')};
  const ssdResult=await capture.receive(ssd.device.deviceId,ssdRaw,ssdPayload,ssdHeaders);
  assert.equal(ssdResult.state,'recorded');
  const ssdInbox=await models.smsInboxModel(conn).findById(ssdResult.id).lean(),ssdRecord=await models.mobileTransactionModel(conn).findById(ssdInbox.recordId).lean();
  assert.equal(ssdRecord.network,'MTN SSD');assert.equal(ssdRecord.currency,'SSP');assert.equal(String(ssdRecord.amountMinor),'100025');assert.equal(String(ssdRecord.feeMinor),'1005');
  assert.equal(String(ssdRecord.cashSessionId),String(sspShift._id));assert.equal(String((await models.cashSessionModel(conn).findById(shift._id)).provisionalMovementMinor),originalMovement);
  assert.equal(String((await models.cashSessionModel(conn).findById(sspShift._id)).provisionalMovementMinor),'100025');
  assert.equal((await capture.receive(ssd.device.deviceId,ssdRaw,ssdPayload,ssdHeaders)).duplicate,true);
  assert.equal((await Usage.findOne({tenantId:tenant._id})).quantity,9);
  console.log('PASS: signed HTTP Android delivery, sender/tenant/signature/time rejection, encrypted credentials/SMS, scoped automatic recording, pending verification, duplicate safety, unknown review, verified-shift control, branch/staff reassignment, SMS quota atomicity, manual entry at full SMS quota, interrupted-recording recovery, browser auth/CSRF and revocation');
  console.log('PASS: enrolled MTN SSD device records explicit SSP confirmations with exact cents into its own verified SSP drawer; UGX drawer and duplicate/quota protections remain intact.');
}
async function cleanup(){
  if(server)await new Promise(resolve=>server.close(resolve));
  if(mongoose.connection.readyState===1&&mongoose.connection.name===scratch&&/^cfh_sms_probe_[a-f0-9]{16}$/.test(scratch)){
    if(conn)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();
  }
  await mongoose.disconnect();
}
main().catch(error=>{console.error('SMS CAPTURE INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(()=>{console.error('SMS scratch cleanup failed');process.exitCode=1;}));
