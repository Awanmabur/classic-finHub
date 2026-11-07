'use strict';
// Internal tenant messaging is a separate, optionally subscribed product.
// Account-security messages remain part of platform identity, not this addon.
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const models=require('../models');
const {hasPermission,hasModuleForUser}=require('./moduleAccess.service');
const {BRANCH_INVITABLE}=require('../../config/roles');
const {sendMail}=require('../../config/mail');
const OID=/^[0-9a-f]{24}$/i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE=/^[a-z][a-z0-9_]{2,39}$/;
const ALLOWED_TOKENS=Object.freeze(['recipient_name','tenant_name','sender_name']);
const MAX_ATTEMPTS=6;
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
function objectId(value){if(!OID.test(String(value||'')))throw fail('Invalid notification identifier',404);return String(value);}
function plain(value,name,min,max){
 if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw fail(`${name} must contain ${min}–${max} plain-text characters`);
 return value.trim();
}
function access(tenant,user,permission){
 if(!hasModuleForUser(tenant,user,'notifications')||!hasPermission(user,permission))throw fail('Notifications subscription and user permission required',403);
}
function templateInput(input){
 const code=String(input?.code||'').trim().toLowerCase();
 if(!CODE.test(code)||code.startsWith('system_'))throw fail('Invalid or reserved template code');
 const name=plain(input?.name,'Template name',3,100);
 const subject=plain(input?.subject,'Subject',3,120);
 const body=plain(input?.body,'Message',5,1000);
 const tokens=[...subject.matchAll(/{{([^}]+)}}/g),...body.matchAll(/{{([^}]+)}}/g)].map(m=>m[1]);
 if(tokens.some(t=>!ALLOWED_TOKENS.includes(t))||[subject,body].some(t=>t.replace(/{{(?:recipient_name|tenant_name|sender_name)}}/g,'').includes('{{')))
   throw fail('Unsupported template variable');
 if(/https?:\/\//i.test(subject+body))throw fail('Templates cannot include arbitrary external links');
 return {code,name,subject,body,emailAvailable:input?.emailAvailable===true||input?.emailAvailable==='on'};
}
function renderText(content,vars){return content.replace(/{{(recipient_name|tenant_name|sender_name)}}/g,(_,key)=>vars[key]);}
function canManage(tenant,user){return hasModuleForUser(tenant,user,'notifications')&&user.role==='Tenant Owner'&&hasPermission(user,'notifications.manage_templates');}
function canSend(tenant,user){return hasModuleForUser(tenant,user,'notifications')&&['Tenant Owner','Branch Manager'].includes(user.role)&&hasPermission(user,'notifications.send');}
function sendableRecipient(actor,recipient,tenant){
 if(!recipient||recipient.status!=='active'||!hasModuleForUser(tenant,recipient,'notifications'))return false;
 if(actor.role==='Tenant Owner')return true;
 return actor.role==='Branch Manager'&&OID.test(String(actor.branchId||''))&&
  String(recipient.branchId||'')===String(actor.branchId)&&BRANCH_INVITABLE.includes(recipient.role);
}
function scope(actor){if(actor.role==='Tenant Owner')return require('./branchView.service').readScope(actor);
 if(!OID.test(String(actor.branchId||'')))throw fail('Active branch assignment required',403);
 return {branchId:String(actor.branchId)};
}
async function templates(conn,tenant,actor){access(tenant,actor,'notifications.view');
 return models.notificationTemplateModel(conn).find({status:'active'}).sort({name:1}).limit(100).lean();}
async function publish(conn,tenant,actor,input){access(tenant,actor,'notifications.manage_templates');
 if(actor.role!=='Tenant Owner')throw fail('Only Tenant Owner can publish notification templates',403);
 const v=templateInput(input);await models.ensureTenantIndexes(conn);
 const session=await conn.startSession();let published;
 try{await session.withTransaction(async()=>{
  const Model=models.notificationTemplateModel(conn);
  const latest=await Model.findOne({code:v.code}).sort({version:-1}).session(session);
  const version=latest?latest.version+1:1;if(version>99999)throw fail('Template version limit reached',409);
  await Model.updateOne({code:v.code,status:'active'},{$set:{status:'retired',retiredAt:new Date(),retiredBy:actor.id}},{session});
  [published]=await Model.create([{...v,version,createdBy:actor.id}],{session});
  await models.auditEventModel(conn).create([{actorId:actor.id,targetId:published._id,action:'notifications.template.published',metadata:{code:v.code,version}}],{session});
 });return published;}catch(e){if(e.code===11000)throw fail('Template was changed concurrently. Refresh and retry.',409);throw e;}finally{await session.endSession();}
}
async function retire(conn,tenant,actor,code){access(tenant,actor,'notifications.manage_templates');
 if(actor.role!=='Tenant Owner'||!CODE.test(code))throw fail('Template not available',403);
 await models.ensureTenantIndexes(conn);const session=await conn.startSession();let row;
 try{await session.withTransaction(async()=>{
  row=await models.notificationTemplateModel(conn).findOneAndUpdate({code,status:'active'},{$set:{status:'retired',retiredAt:new Date(),retiredBy:actor.id}},{session,new:true});
  if(!row)throw fail('Active template not found',404);
  await models.auditEventModel(conn).create([{actorId:actor.id,targetId:row._id,action:'notifications.template.retired',metadata:{code,version:row.version}}],{session});
 });return row;}finally{await session.endSession();}
}
async function recipients(conn,tenant,actor,search=""){access(tenant,actor,'notifications.send');
 if(!canSend(tenant,actor))throw fail('Message sending not authorized',403);
 const q=String(search||'').trim();if(q.length>80)throw fail('Recipient search is too long');
 const escaped=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const users=await models.tenantUserModel(conn).find({status:'active',...(q?{name:{$regex:escaped,$options:'i'}}:{}),...(actor.role==='Tenant Owner'?require('./branchView.service').readScope(actor):{branchId:actor.branchId,role:{$in:BRANCH_INVITABLE}})})
  .select('_id name role branchId allowedModules status').sort({name:1}).limit(50).lean();
 return users.filter(u=>sendableRecipient(actor,u,tenant));
}
function messageInput(input){
 const recipientId=objectId(input?.recipientId),code=String(input?.templateCode||'');
 const idempotencyKey=String(input?.idempotencyKey||'').toLowerCase();
 if(!CODE.test(code)||!UUID.test(idempotencyKey))throw fail('Choose a template and valid request key');
 return {recipientId,code,idempotencyKey};
}
async function send(conn,tenant,actor,input){access(tenant,actor,'notifications.send');if(!canSend(tenant,actor))throw fail('Sending is not permitted',403);
 const v=messageInput(input),dedupeKey=`manual:${v.idempotencyKey}`;
 await models.ensureTenantIndexes(conn);
 const Msg=models.notificationMessageModel(conn);
 const duplicate=await Msg.findOne({dedupeKey}).lean();
 if(duplicate){if(String(duplicate.senderId)!==String(actor.id)||String(duplicate.recipientId)!==v.recipientId||duplicate.templateCode!==v.code)
  throw fail('This request key is already used for a different notification',409);
  return {message:duplicate,duplicate:true};}
 const session=await conn.startSession();let message;
 try{await session.withTransaction(async()=>{
  const recipient=await models.tenantUserModel(conn).findOne({_id:v.recipientId,status:'active'}).session(session).lean();
  if(!sendableRecipient(actor,recipient,tenant))throw fail('Recipient outside your assigned module or branch',403);
  const template=await models.notificationTemplateModel(conn).findOne({code:v.code,status:'active'}).session(session).lean();
  if(!template)throw fail('Template is unavailable',409);
  const preference=await models.notificationPreferenceModel(conn).findOne({userId:v.recipientId}).session(session).lean();
  const variables={recipient_name:recipient.name,tenant_name:tenant.name,sender_name:String(actor.name||'Administrator')};
  [message]=await Msg.create([{dedupeKey,recipientId:recipient._id,senderId:actor.id,
   branchId:recipient.branchId||null,templateCode:template.code,templateVersion:template.version,
   subject:renderText(template.subject,variables),body:renderText(template.body,variables),
   emailState:template.emailAvailable&&preference?.emailOptIn===true?'pending':'not_requested'}],{session});
  await models.auditEventModel(conn).create([{actorId:actor.id,targetId:message._id,action:'notifications.message.created',
    metadata:{branchId:recipient.branchId||null,recipientId:String(recipient._id),templateCode:template.code,
      emailRequested:message.emailState==='pending'}}],{session});
 });return {message,duplicate:false};}catch(e){if(e.code===11000){const existing=await Msg.findOne({dedupeKey}).lean();
  if(existing&&String(existing.senderId)===String(actor.id)&&String(existing.recipientId)===v.recipientId&&existing.templateCode===v.code)
    return {message:existing,duplicate:true};throw fail('Request key already used',409);}throw e;}
 finally{await session.endSession();}
}
async function requeue(conn,tenant,actor,id,reason){
 access(tenant,actor,'notifications.manage_templates');
 if(actor.role!=='Tenant Owner')throw fail('Only Tenant Owner may retry failed delivery',403);
 const note=plain(reason,'Retry justification',20,400),messageId=objectId(id);
 await models.ensureTenantIndexes(conn);
 const session=await conn.startSession();let updated;
 try{await session.withTransaction(async()=>{
  const Msg=models.notificationMessageModel(conn);
  const record=await Msg.findOne({_id:messageId,emailState:'dead'}).session(session).lean();
  if(!record)throw fail('Only dead-lettered email can be retried',409);
  const recipient=await models.tenantUserModel(conn).findOne({_id:record.recipientId,status:'active'}).session(session).lean();
  const prefs=recipient?await models.notificationPreferenceModel(conn).findOne({userId:recipient._id}).session(session).lean():null;
  if(!recipient||!hasModuleForUser(tenant,recipient,'notifications')||!prefs?.emailOptIn)
   throw fail('Recipient must be active, entitled and opted in before retrying email',409);
  updated=await Msg.findOneAndUpdate({_id:messageId,emailState:'dead'},
   {$set:{emailState:'pending',attempts:0,availableAt:new Date(),failureCode:null,
     leaseUntil:null,leaseToken:null}},{new:true,session});
  if(!updated)throw fail('Notification delivery status changed concurrently',409);
  await models.auditEventModel(conn).create([{actorId:actor.id,targetId:record._id,
   action:'notifications.delivery.requeued',metadata:{branchId:record.branchId||null,reason:note}}],{session});
 });return updated;}finally{await session.endSession();}
}
async function inbox(conn,tenant,actor,{cursor}={}){access(tenant,actor,'notifications.view');
 const filter={recipientId:objectId(actor.id)};
 if(cursor){if(!OID.test(String(cursor)))throw fail('Invalid inbox cursor');filter._id={$lt:new mongoose.Types.ObjectId(cursor)};}
 const items=await models.notificationMessageModel(conn).find(filter).select('-body').sort({_id:-1}).limit(31).lean();
 return {items:items.slice(0,30),nextCursor:items.length>30?String(items[29]._id):null};
}
async function detail(conn,tenant,actor,id){access(tenant,actor,'notifications.view');
 const row=await models.notificationMessageModel(conn).findOne({_id:objectId(id),recipientId:objectId(actor.id)}).lean();
 if(!row)throw fail('Notification not found',404);return row;}
async function markRead(conn,tenant,actor,id){access(tenant,actor,'notifications.view');
 const row=await models.notificationMessageModel(conn).findOneAndUpdate({_id:objectId(id),recipientId:objectId(actor.id),readAt:null},
  {$set:{readAt:new Date()}},{new:true});
 if(row)return row;
 return detail(conn,tenant,actor,id);
}
async function preference(conn,tenant,actor){access(tenant,actor,'notifications.view');
 return await models.notificationPreferenceModel(conn).findOne({userId:objectId(actor.id)}).lean()||{emailOptIn:false};
}
async function setPreference(conn,tenant,actor,input){access(tenant,actor,'notifications.view');
 if(input?.emailOptIn!==undefined&&!['on','off',true,false].includes(input.emailOptIn))throw fail('Invalid email preference');
 const emailOptIn=input?.emailOptIn==='on'||input?.emailOptIn===true;
 await models.ensureTenantIndexes(conn);
 const session=await conn.startSession();let updated;
 try{await session.withTransaction(async()=>{
  updated=await models.notificationPreferenceModel(conn).findOneAndUpdate({userId:actor.id},
   {$set:{emailOptIn,updatedAt:new Date()}},{upsert:true,new:true,runValidators:true,session});
  await models.auditEventModel(conn).create([{actorId:actor.id,targetId:actor.id,action:'notifications.preference.updated',metadata:{emailOptIn}}],{session});
 });return updated;}finally{await session.endSession();}
}
async function logs(conn,tenant,actor){access(tenant,actor,'notifications.logs');
 if(!['Tenant Owner','Branch Manager'].includes(actor.role))throw fail('Notification logs not permitted',403);
 return models.notificationMessageModel(conn).find(scope(actor))
  .select('_id branchId templateCode createdAt emailState attempts failureCode readAt')
  .sort({_id:-1}).limit(100).lean();
}
// Optional, deliberately narrow cross-module event. A missing subscription never
// blocks a core financial or approval operation. Used only inside caller's DB tx.
async function approvalEvent(conn,tenant,request,recipientId,session){
 if(!session||!hasModuleForUser(tenant,{role:'Tenant Owner'},'notifications'))return null;
 const recipient=await models.tenantUserModel(conn).findOne({_id:objectId(recipientId),status:'active'}).session(session).lean();
 if(!recipient||!hasModuleForUser(tenant,recipient,'notifications'))return null;
 const dedupeKey=`approval:${request._id}:${request.revision}:${recipientId}`;
 const [notice]=await models.notificationMessageModel(conn).create([{
  dedupeKey,recipientId:recipient._id,senderId:request.requesterId,
  branchId:recipient.branchId||null,templateCode:'system_approval',templateVersion:1,
  subject:'Approval request updated',body:`Request ${request.reference} is now ${request.status}. Open Approval Workflows for details.`,
  source:'approval_request',sourceId:request._id,emailState:'not_requested'
 }],{session});return notice;
}
function claimFilter(now){return {$or:[{emailState:{$in:['pending','retry']},availableAt:{$lte:now}},
 {emailState:'processing',leaseUntil:{$lte:now}}]};}
async function claimOne(conn,workerId,now=new Date()){
 const leaseToken=crypto.randomUUID();
 const row=await models.notificationMessageModel(conn).findOneAndUpdate(claimFilter(now),
  {$set:{emailState:'processing',leaseToken,leaseUntil:new Date(now.getTime()+45000)},$inc:{attempts:1}},
  {sort:{availableAt:1,_id:1},new:true});
 return row?{row,leaseToken,workerId}:null;
}
function retryDelay(attempts){return Math.min(3600000,30000*Math.pow(2,Math.min(7,attempts-1)));}
function classify(error){const status=error?.providerStatus;
 if(error?.code==='MAIL_NOT_CONFIGURED')return 'MAIL_NOT_CONFIGURED';
 if(Number.isSafeInteger(status)&&status>=400&&status<500&&status!==429)return 'PERMANENT_PROVIDER_REJECTION';
 return 'TRANSIENT_PROVIDER_ERROR';
}
async function processOne(conn,tenant,workerId,mailer=sendMail){
 const claimed=await claimOne(conn,workerId);if(!claimed)return null;
 const {row,leaseToken}=claimed,Model=models.notificationMessageModel(conn);
 const filter={_id:row._id,emailState:'processing',leaseToken};
 try{
  if(!hasModuleForUser(tenant,{role:'Tenant Owner'},'notifications')){
   await Model.updateOne(filter,{$set:{emailState:'suppressed',leaseToken:null,leaseUntil:null,failureCode:'MODULE_UNAVAILABLE'}});
   return {state:'suppressed'};
  }
  const recipient=await models.tenantUserModel(conn).findOne({_id:row.recipientId,status:'active'}).select('email role branchId allowedModules status').lean();
  const opt=recipient?await models.notificationPreferenceModel(conn).findOne({userId:recipient._id}).lean():null;
  if(!recipient||!hasModuleForUser(tenant,recipient,'notifications')||!opt?.emailOptIn){
   await Model.updateOne(filter,{$set:{emailState:'suppressed',leaseToken:null,leaseUntil:null,failureCode:'RECIPIENT_UNAVAILABLE'}});
   return {state:'suppressed'};
  }
  const accepted=await mailer({to:recipient.email,subject:row.subject,text:row.body,idempotencyKey:`cfh-notification-${row._id}`});
  if(accepted?.status!=='accepted'||!accepted?.messageId)throw new Error('Provider did not confirm message acceptance');
  await Model.updateOne(filter,{$set:{emailState:'accepted',acceptedMessageId:accepted.messageId,
   acceptedAt:new Date(),leaseToken:null,leaseUntil:null,failureCode:null}});
  return {state:'accepted'};
 }catch(error){
  const reason=classify(error),dead=row.attempts>=MAX_ATTEMPTS||reason==='PERMANENT_PROVIDER_REJECTION';
  await Model.updateOne(filter,{$set:{emailState:dead?'dead':'retry',failureCode:reason,leaseToken:null,
   leaseUntil:null,availableAt:new Date(Date.now()+retryDelay(row.attempts))}});
  return {state:dead?'dead':'retry',failureCode:reason};
 }
}
module.exports={ALLOWED_TOKENS,templateInput,renderText,access,canManage,canSend,sendableRecipient,scope,
 templates,publish,retire,recipients,messageInput,send,requeue,inbox,detail,markRead,preference,setPreference,logs,
 approvalEvent,claimFilter,claimOne,retryDelay,classify,processOne};
