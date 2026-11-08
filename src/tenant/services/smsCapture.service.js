'use strict';
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const SmsDevice=require('../../platform/models/SmsDevice');
const SmsUsage=require('../../platform/models/SmsUsage');
const Tenant=require('../../platform/models/Tenant');
const {getTenantConnection}=require('../../config/mongo');
const {effectiveSubscription,periodKey}=require('../../platform/services/commercial.service');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const {permissionsFor}=require('../../config/roles');
const {tenantUserModel,smsInboxModel,auditEventModel,ensureTenantIndexes}=require('../models');
const {resolveTransactionBranch}=require('./transactionBranch.service');
const mobile=require('./mobileMoney.service');
const {parseSms}=require('./smsParser.service');
const secure=require('./smsCrypto.service');
const ID=/^[a-f0-9]{24}$/i;
const RETENTION_MS=30*86400000;
let indexes;
async function ensurePlatformIndexes(){
  if(!indexes)indexes=Promise.all([SmsDevice.createIndexes(),SmsUsage.createIndexes()]).catch(e=>{indexes=null;throw e;});
  return indexes;
}
function entitlement(tenant,actor){
  const plan=effectiveSubscription(tenant);
  if(!['active','trial'].includes(tenant?.status)||!plan||!plan.modules.includes('sms_capture')||
    !plan.modules.includes('mobile_money')||!Number.isSafeInteger(plan.limits.smsPerMonth)||plan.limits.smsPerMonth<1||
    !hasModuleForUser(tenant,actor,'sms_capture')||!hasModuleForUser(tenant,actor,'mobile_money'))
    throw secure.fail('An active SMS-assisted plan and Mobile Money assignment are required.',403);
  return plan;
}
function operatorFrom(account){
  return {id:String(account._id),name:account.name,role:account.role,authVersion:account.authVersion||0,branchId:account.branchId||null,
    permissions:permissionsFor(account.role),allowedModules:account.allowedModules||[]};
}
function assertOperator(actor){
  if(!actor?.id||!['Tenant Owner','Mobile Money Operator'].includes(actor.role)||
    !hasPermission(actor,'mobile_money.cash_in')||!hasPermission(actor,'mobile_money.cash_out'))
    throw secure.fail('An active Mobile Money operator is required.',403);
}
function senders(raw){
  if(typeof raw!=='string'||raw.length>300)throw secure.fail('Enter one to eight trusted SMS senders.');
  const list=raw.split(',').map(v=>v.trim().toUpperCase()).filter(Boolean);
  if(!list.length||list.length>8||new Set(list).size!==list.length||list.some(v=>!/^\+?[A-Z0-9][A-Z0-9 ._-]{0,38}$/.test(v)))
    throw secure.fail('Use unique sender names or phone numbers, separated by commas.');
  return list;
}
async function enroll(conn,tenant,owner,input){
  if(owner?.role!=='Tenant Owner')throw secure.fail('Only the tenant owner can enroll SMS devices.',403);
  entitlement(tenant,owner);
  if(!input||!ID.test(String(input.operatorId||'')))throw secure.fail('Choose an active Mobile Money operator.');
  const account=await tenantUserModel(conn).findOne({_id:input.operatorId,status:'active'}).lean();
  if(!account)throw secure.fail('The selected operator is unavailable.',403);
  const actor=operatorFrom(account);assertOperator(actor);entitlement(tenant,actor);
  const branch=await resolveTransactionBranch(conn,actor);
  const name=String(input.name||'').trim();
  if(name.length<3||name.length>80||!require('../../config/mobileNetworks').smsNetworks.includes(input.network))throw secure.fail('Enter a device name and supported network.');
  const allowedSenders=senders(input.allowedSenders),deviceId=crypto.randomBytes(16).toString('hex');
  const secret=crypto.randomBytes(32).toString('hex'),secretEncrypted=secure.encrypt(secret,`device:${deviceId}`);
  await ensurePlatformIndexes();await ensureTenantIndexes(conn);
  const session=await mongoose.startSession();let device;
  try{await session.withTransaction(async()=>{
    // Lock the tenant entitlement while creating a credential. Subscription
    // updates use optimistic concurrency and cannot silently race enrollment.
    const fenced=await Tenant.findOneAndUpdate({_id:tenant._id,__v:tenant.__v,status:{$in:['active','trial']}},{$inc:{__v:1}},{session,new:true});
    if(!fenced)throw secure.fail('Workspace settings changed. Refresh and retry.',409);
    entitlement(fenced,actor);
    await require('./smsAuthorization.service').fenceOperator(conn,session,actor,fenced,branch._id);
    if(await SmsDevice.countDocuments({tenantId:tenant._id,status:'active'}).session(session)>=20)
      throw secure.fail('Revoke an unused device before enrolling another (maximum 20).',409);
    [device]=await SmsDevice.create([{deviceId,tenantId:tenant._id,operatorId:actor.id,branchId:branch._id,name,
      network:input.network,allowedSenders,secretEncrypted,autoRecord:input.autoRecord==='on',createdBy:owner.id}],{session});
    await auditEventModel(conn).create([{action:'sms.device.enrolled',actorId:owner.id,targetId:device._id,
      metadata:{deviceId,branchId:String(branch._id),operatorId:actor.id,autoRecord:device.autoRecord}}],{session});
  });}finally{await session.endSession();}
  return {device:device.toObject(),secret};
}
async function revoke(conn,tenant,owner,deviceId){
  if(owner?.role!=='Tenant Owner')throw secure.fail('Only the tenant owner can revoke SMS devices.',403);
  if(!/^[a-f0-9]{32}$/.test(String(deviceId)))throw secure.fail('Invalid device.');
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    const device=await SmsDevice.findOneAndUpdate({deviceId,tenantId:tenant._id,status:'active'},
      {$set:{status:'revoked',revokedAt:new Date()},$inc:{revision:1}},{session,new:true});
    if(!device)throw secure.fail('Device is unavailable or already revoked.',409);
    await auditEventModel(conn).create([{action:'sms.device.revoked',actorId:owner.id,targetId:device._id,
      metadata:{deviceId,branchId:String(device.branchId)}}],{session});
  });}finally{await session.endSession();}
}
function validatePayload(input,now=Date.now()){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='body,messageId,receivedAt,sender'||
    typeof input.messageId!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(input.messageId)||
    typeof input.sender!=='string'||input.sender.trim().length<1||input.sender.length>40||/[\u0000-\u001f\u007f]/.test(input.sender)||
    typeof input.body!=='string'||input.body.length<1||input.body.length>2000||/\u0000/.test(input.body)||
    typeof input.receivedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.receivedAt))
    throw secure.fail('Use the documented SMS envelope with messageId, sender, receivedAt and body only.');
  const at=Date.parse(input.receivedAt);
  const canonical=input.receivedAt.includes('.')?input.receivedAt:input.receivedAt.replace(/Z$/,'.000Z');
  if(!Number.isFinite(at)||new Date(at).toISOString()!==canonical||at>now+300000||at<now-RETENTION_MS)
    throw secure.fail('SMS receivedAt must be valid and within the last 30 days.');
  return {messageId:input.messageId,sender:input.sender.trim().toUpperCase(),receivedAt:new Date(at).toISOString(),body:input.body};
}
async function boundContext(device){
  const tenant=await Tenant.findById(device.tenantId).lean();
  if(!tenant)throw secure.fail('SMS workspace is unavailable.',403);
  const conn=getTenantConnection(tenant.slug);
  const account=await tenantUserModel(conn).findOne({_id:device.operatorId,status:'active'}).lean();
  if(!account)throw secure.fail('Device operator is disabled or unavailable.',403);
  const actor=operatorFrom(account);assertOperator(actor);const plan=entitlement(tenant,actor);
  const branch=await resolveTransactionBranch(conn,actor);
  if(String(branch._id)!==String(device.branchId))throw secure.fail('Operator branch changed. Revoke and enroll the device again.',403);
  return {tenant,conn,actor,branch,plan};
}
function publicResult(row,duplicate){return {accepted:true,id:String(row._id),state:row.state,duplicate};}
async function reserveSms(tenant,plan,session){
  const filter={tenantId:tenant._id,generation:plan.generation,period:periodKey()};
  try{
    const usage=await SmsUsage.findOneAndUpdate({...filter,quantity:{$lt:plan.limits.smsPerMonth}},
      {$inc:{quantity:1},$setOnInsert:filter},{session,upsert:true,new:true});
    if(!usage)throw secure.fail('Monthly SMS allocation exhausted.',429);
  }catch(error){if(error.code===11000)throw secure.fail('Monthly SMS allocation exhausted.',429);throw error;}
}
async function receive(deviceId,raw,input,headers){
  if(!/^[a-f0-9]{32}$/.test(String(deviceId)))throw secure.fail('Invalid SMS credentials.',401);
  const device=await SmsDevice.findOne({deviceId}).select('+secretEncrypted').lean();
  if(!device||!secure.verifySignature(secure.decrypt(device.secretEncrypted,`device:${deviceId}`),raw,headers.timestamp,headers.signature))
    throw secure.fail('Invalid SMS signature or expired timestamp.',401);
  if(device.status!=='active')throw secure.fail('SMS device is revoked.',403);
  const values=validatePayload(input);
  if(!device.allowedSenders.includes(values.sender))throw secure.fail('SMS sender is not allowed for this device.',403);
  const context=await boundContext(device),{tenant,conn,plan}=context;
  await ensurePlatformIndexes();await ensureTenantIndexes(conn);
  const Inbox=smsInboxModel(conn),payloadDigest=crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
  let row=await Inbox.findOne({deviceId,messageId:values.messageId}).lean();let duplicate=!!row;
  if(row&&row.payloadDigest!==payloadDigest)throw secure.fail('Message ID was already used for different SMS contents.',409);
  if(!row){
    const parsed=parseSms(values.body,{network:device.network});
    const session=await mongoose.startSession();
    try{await session.withTransaction(async()=>{
      const fenced=await require('./smsAuthorization.service').fenceDeviceContext(conn,session,
        {deviceId,tenantId:tenant._id,actor:context.actor,branchId:device.branchId});
      await SmsDevice.updateOne({_id:device._id},{$set:{lastReceivedAt:new Date()}},{session});
      const currentPlan=entitlement(fenced.tenant,fenced.actor);
      await reserveSms(fenced.tenant,currentPlan,session);
      [row]=await Inbox.create([{deviceId,messageId:values.messageId,payloadDigest,operatorId:device.operatorId,branchId:device.branchId,
        sender:values.sender,receivedAt:new Date(values.receivedAt),bodyEncrypted:secure.encrypt(values.body,`sms:${deviceId}:${values.messageId}`),
        fields:parsed.fields,state:parsed.state,reasonCode:parsed.reasonCode,expiresAt:new Date(Date.now()+RETENTION_MS)}],{session});
    });}catch(error){
      if(error.code!==11000)throw error;
      row=await Inbox.findOne({deviceId,messageId:values.messageId}).lean();
      if(!row)throw error;
      if(row.payloadDigest!==payloadDigest)throw secure.fail('Message ID was already used for different SMS contents.',409);
      duplicate=true;
    }finally{await session.endSession();}
  }
  if(device.autoRecord&&row.state==='parsed'){
    await recordDraft(conn,tenant,context.actor,String(row._id),row.fields,true).catch(()=>{});
    row=await Inbox.findById(row._id).lean();
  }
  return publicResult(row,duplicate);
}
function scope(actor){return actor.role==='Tenant Owner'?require('./branchView.service').readScope(actor):{operatorId:actor.id,branchId:actor.branchId||null};}
async function recoverExpired(conn){
  // If a process died after recording, the persisted fields and deterministic
  // key let the operator safely retry the same record without consuming quota.
  await smsInboxModel(conn).updateMany({state:'processing',processingUntil:{$lt:new Date()}},
    {$set:{state:'needs_review',reasonCode:'interrupted_recording_retry_safely',processingToken:null,processingUntil:null}});
}
async function getInbox(conn,tenant,actor,{cursor}={}){
  entitlement(tenant,actor);assertOperator(actor);
  await ensureTenantIndexes(conn);await ensurePlatformIndexes();
  await recoverExpired(conn);
  const position=mobile.decodeCursor(cursor),filter={...scope(actor),expiresAt:{$gt:new Date()}};
  if(position)filter.$or=[{createdAt:{$lt:position.at}},{createdAt:position.at,_id:{$lt:new mongoose.Types.ObjectId(position.id)}}];
  const [items,devices,operators,usage]=await Promise.all([
    smsInboxModel(conn).find(filter).sort({createdAt:-1,_id:-1}).limit(101).lean(),
    SmsDevice.find({tenantId:tenant._id,...(actor.role==='Tenant Owner'?require('./branchView.service').readScope(actor):{operatorId:actor.id})}).sort({createdAt:-1}).limit(100).lean(),
    actor.role==='Tenant Owner'?tenantUserModel(conn).find({status:'active',role:{$in:['Tenant Owner','Mobile Money Operator']},...require('./branchView.service').readScope(actor)}).select('name role branchId allowedModules').limit(200).lean():[],
    SmsUsage.findOne({tenantId:tenant._id,generation:effectiveSubscription(tenant).generation,period:periodKey()}).lean()
  ]);
  return {items:items.slice(0,100),nextCursor:items.length>100?mobile.encodeCursor(items[99]):null,
    devices,operators,usage:usage?.quantity||0,limit:effectiveSubscription(tenant).limits.smsPerMonth,canManage:actor.role==='Tenant Owner'};
}
async function getDraft(conn,tenant,actor,id){
  entitlement(tenant,actor);assertOperator(actor);
  if(!ID.test(String(id)))throw secure.fail('Invalid SMS item.');
  await recoverExpired(conn);
  const row=await smsInboxModel(conn).findOne({_id:id,...scope(actor),expiresAt:{$gt:new Date()}}).select('+bodyEncrypted').lean();
  if(!row)throw secure.fail('SMS item not found within your access scope.',404);
  return {...row,body:secure.decrypt(row.bodyEncrypted,`sms:${row.deviceId}:${row.messageId}`)};
}
async function recordDraft(conn,tenant,actor,id,input,automatic=false){
  entitlement(tenant,actor);assertOperator(actor);
  if(!ID.test(String(id)))throw secure.fail('Invalid SMS item.');
  const Inbox=smsInboxModel(conn),prior=await Inbox.findOne({_id:id,...scope(actor)}).lean();
  if(!prior||String(prior.operatorId)!==String(actor.id))throw secure.fail('Only this device’s assigned operator can record the SMS draft.',403);
  if(prior.state==='recorded')return {created:{_id:prior.recordId},duplicate:true};
  const device=await SmsDevice.findOne({deviceId:prior.deviceId,tenantId:tenant._id,status:'active'}).lean();
  if(!device)throw secure.fail('SMS device is unavailable. Use manual Mobile Money entry if appropriate.',403);
  const fresh=await boundContext(device);
  if(String(fresh.actor.id)!==String(actor.id))throw secure.fail('Device assignment changed.',403);
  const values={};for(const key of ['operation','customer','network','networkReference','currency','amount','fee','observedWalletBalance','observationEvidenceReference'])values[key]=input?.[key];
  values.idempotencyKey=secure.idempotencyKey(device.deviceId,prior.messageId);
  mobile.validate(values,values.operation);
  if(values.network!==device.network)throw secure.fail('The network must match the enrolled SMS device.');
  const token=crypto.randomUUID(),now=new Date();
  const claimed=await Inbox.findOneAndUpdate({_id:id,expiresAt:{$gt:now},$or:[{state:{$in:['parsed','needs_review']}},{state:'processing',processingUntil:{$lt:now}}]},
    {$set:{state:'processing',fields:valuesWithoutKey(values),processingToken:token,processingUntil:new Date(Date.now()+60000)}},{new:true});
  if(!claimed)throw secure.fail('This SMS is already recorded, dismissed or being processed. Refresh the inbox.',409);
  try{
    const result=await mobile.recordMobileMoney(conn,fresh.actor,values,values.operation,fresh.tenant,{smsInboxId:id});
    await Inbox.updateOne({_id:id,processingToken:token},{$set:{state:'recorded',reasonCode:automatic?'auto_recorded_pending_verification':'confirmed_pending_verification',
      recordId:result.created._id,fields:valuesWithoutKey(values),confirmedBy:actor.id,confirmedAt:new Date(),processingToken:null,processingUntil:null}});
    return result;
  }catch(error){
    await Inbox.updateOne({_id:id,processingToken:token},{$set:{state:'needs_review',reasonCode:error.code==='SMS_SHIFT_MISMATCH'?'sms_predates_verified_shift':error.status===429?'transaction_quota_exhausted':error.status===403?'operator_or_subscription_unavailable':error.status===409?'cash_shift_or_reference_conflict':'recording_requires_review',processingToken:null,processingUntil:null}});
    throw error;
  }
}
function valuesWithoutKey(values){const {idempotencyKey,...fields}=values;return fields;}
async function dismiss(conn,tenant,actor,id,note){
  entitlement(tenant,actor);assertOperator(actor);
  if(!ID.test(String(id))||typeof note!=='string'||note.trim().length<8||note.trim().length>200)throw secure.fail('Explain dismissal in 8–200 characters.');
  const session=await conn.startSession();
  try{await session.withTransaction(async()=>{
    const row=await smsInboxModel(conn).findOneAndUpdate({_id:id,...scope(actor),expiresAt:{$gt:new Date()},state:{$in:['parsed','needs_review']}},
      {$set:{state:'dismissed',reasonCode:'dismissed_by_operator',dismissalNote:note.trim(),confirmedBy:actor.id,confirmedAt:new Date()}},{session,new:true});
    if(!row)throw secure.fail('SMS cannot be dismissed or is outside your access scope.',409);
    await auditEventModel(conn).create([{action:'sms.draft.dismissed',actorId:actor.id,targetId:row._id,
      metadata:{deviceId:row.deviceId,branchId:String(row.branchId)}}],{session});
  });}finally{await session.endSession();}
}
module.exports={enroll,revoke,receive,getInbox,getDraft,recordDraft,dismiss,ensurePlatformIndexes,validatePayload,senders,entitlement,operatorFrom,RETENTION_MS};
