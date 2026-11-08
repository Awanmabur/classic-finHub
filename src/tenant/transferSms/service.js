'use strict';
const crypto=require('node:crypto');
const {model,ensureIndexes}=require('./models'),encryption=require('./crypto'),provider=require('./provider');
const core=require('../models'),{hasModule}=require('../services/moduleAccess.service');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const MAX_ATTEMPTS=6;
function oid(value){if(!/^[a-f0-9]{24}$/i.test(String(value||'')))throw Object.assign(new Error('Invalid transfer SMS record'),{status:400});return String(value);}
function binding(conn,row){return `${conn.name}:${row.tenantId}:${row.executionId}:${row.sourceId}`;}
function mask(phone){return '•'.repeat(Math.max(0,phone.length-4))+phone.slice(-4);}
function publicRecord(row){if(!row)return null;const {_id,state,recipientMasked,attempts,failureCode,acceptedMessageId,providerState,acceptedAt,createdAt,revision,redrives,lastRequeuedAt}=row;return {_id,state,recipientMasked,attempts,failureCode,acceptedMessageId,providerState,acceptedAt,createdAt,revision,redrives,lastRequeuedAt};}
async function enqueue(conn,input,session){
 if(!session)throw new Error('Transfer SMS enqueue requires a transaction');
 const content=provider.payload(input),config=provider.mode()!=='none',row={tenantId:oid(input.tenantId),branchId:oid(input.branchId),executionId:oid(input.executionId),sourceId:oid(input.sourceId),recipientMasked:mask(content.to),state:config?'pending':'not_configured',failureCode:config?null:'SMS_PROVIDER_NOT_CONFIGURED'};
 if(config||encryption.configured())row.payloadEncrypted=encryption.encrypt(content,binding(conn,row));
 const [saved]=await model(conn).create([row],{session});return publicRecord(saved.toObject());
}
async function record(conn,executionId,session=null){const query=model(conn).findOne({executionId:oid(executionId)}).select('+payloadEncrypted');if(session)query.session(session);return query.lean();}
const {validateConfig}=require('./config');
async function summary(conn,executionId){return publicRecord(await model(conn).findOne({executionId:oid(executionId)}).lean());}
function classify(error){return ['SMS_RATE_LIMITED','SMS_PROVIDER_NOT_CONFIGURED','SMS_KEY_NOT_CONFIGURED','SMS_PROVIDER_REJECTED','SMS_PAYLOAD_INVALID','SMS_SUBMISSION_UNCERTAIN'].includes(error?.code)?error.code:'SMS_SUBMISSION_UNCERTAIN';}
function retryDelay(attempts){return Math.min(3600000,30000*2**Math.min(7,attempts-1));}
async function claimOne(conn,now=new Date()){
 // A worker may have submitted an expired lease before dying. Never blindly
 // repeat that external submission: the operator must inspect the provider.
 await model(conn).updateMany({state:'processing',leaseUntil:{$lte:now}},{$set:{state:'uncertain',failureCode:'SMS_SUBMISSION_UNCERTAIN',leaseToken:null,leaseUntil:null},$inc:{revision:1}});
 const token=crypto.randomUUID();
 return model(conn).findOneAndUpdate({state:{$in:['pending','retry']},availableAt:{$lte:now}},{$set:{state:'processing',leaseToken:token,leaseUntil:new Date(now.getTime()+45000)},$inc:{attempts:1,revision:1}},{new:true,sort:{availableAt:1,_id:1}}).select('+payloadEncrypted +leaseToken').lean();
}
async function processOne(conn,tenant,workerId,sendOverride){
 if(conn.name!==tenantDbNameFromSlug(tenant?.slug))throw new Error('Transfer SMS tenant context is invalid');
 const row=await claimOne(conn);if(!row)return null;
 const filter={_id:row._id,state:'processing',leaseToken:row.leaseToken,revision:row.revision};
 async function finish(state,fields={},clear=false){const result=await model(conn).updateOne(filter,{$set:{state,leaseToken:null,leaseUntil:null,...fields},$inc:{revision:1},...(clear?{$unset:{payloadEncrypted:''}}:{})});return {state:result.modifiedCount===1?state:'lease_lost'};}
 try{
  if(String(row.tenantId)!==String(tenant._id)||!['active','trial'].includes(tenant.status)||!hasModule(tenant,'money_transfer'))return finish('suppressed',{failureCode:'SMS_MODULE_UNAVAILABLE'},true);
  const [source,execution,branch]=await Promise.all([
   core.transferOrderModel(conn).findOne({_id:row.sourceId,branchId:row.branchId,status:'collected_manual',manualCollectionExecutionId:row.executionId}).select('_id').lean(),
   require('../funded/models').models(conn).execution.findOne({_id:row.executionId,sourceId:row.sourceId,branchId:row.branchId,action:'transfer_collect',status:'posted_manual'}).select('_id').lean(),
   core.branchModel(conn).findOne({_id:row.branchId,status:'active'}).select('_id').lean()
  ]);
  if(!source||!execution||!branch)return finish('suppressed',{failureCode:'SMS_TRANSFER_UNAVAILABLE'},true);
  // Validate local config even when a test adapter is injected.
  if(!provider.settings())throw Object.assign(new Error('Transfer SMS provider is unavailable'),{code:'SMS_PROVIDER_NOT_CONFIGURED'});
  const content=provider.payload(encryption.decrypt(row.payloadEncrypted,binding(conn,row)));
  const result=await (sendOverride||provider.send)(content);
  if(result?.status!=='accepted'||!/^SM[a-f0-9]{32}$/i.test(result?.messageId||''))throw Object.assign(new Error('SMS provider acknowledgement is unavailable'),{code:'SMS_SUBMISSION_UNCERTAIN'});
  return finish('accepted',{failureCode:null,acceptedMessageId:result.messageId,providerState:['accepted','queued','sending','sent','delivered'].includes(result.providerState)?result.providerState:'accepted',acceptedAt:new Date()},true);
 }catch(error){
  const code=classify(error);
  if(code==='SMS_SUBMISSION_UNCERTAIN')return finish('uncertain',{failureCode:code});
  if(code==='SMS_PROVIDER_NOT_CONFIGURED'||code==='SMS_KEY_NOT_CONFIGURED')return finish('not_configured',{failureCode:code});
  const dead=code==='SMS_PROVIDER_REJECTED'||code==='SMS_PAYLOAD_INVALID'||row.attempts>=MAX_ATTEMPTS;
  return finish(dead?'dead':'retry',{failureCode:code,availableAt:new Date(Date.now()+retryDelay(row.attempts))});
 }
}
async function closeAfterPayout(conn,executionId,session){
 if(!session)throw new Error('Transfer SMS closure requires a transaction');
 // Fence an in-flight worker as well. A provider request already submitted
 // cannot be recalled, but its delayed acknowledgement cannot reopen this row.
 return model(conn).updateMany({executionId:oid(executionId),state:{$nin:['accepted','suppressed']}},{$set:{state:'suppressed',failureCode:'SMS_TRANSFER_PAID',leaseToken:null,leaseUntil:null},$unset:{payloadEncrypted:''},$inc:{revision:1}},{session});
}
async function requeue(conn,messageId,content,session){
 if(!session)throw new Error('Transfer SMS retry requires a transaction');
 if(provider.mode()==='none')throw Object.assign(new Error('Configure the transfer SMS provider before retrying'),{status:409});
 const previous=await model(conn).findOne({_id:oid(messageId),state:{$in:['dead','not_configured']}}).session(session).select('+payloadEncrypted').lean();
 if(!previous)throw Object.assign(new Error('Only failed or unconfigured transfer SMS can be retried'),{status:409});
 if((previous.redrives||0)>=3)throw Object.assign(new Error('Transfer SMS retry limit reached; inspect the provider and use controlled manual handoff'),{status:409});
 if(previous.lastRequeuedAt&&new Date(previous.lastRequeuedAt)>new Date(Date.now()-60000))throw Object.assign(new Error('Wait one minute before retrying transfer SMS'),{status:429});
 const value=content?provider.payload(content):provider.payload(encryption.decrypt(previous.payloadEncrypted,binding(conn,previous)));
 const payloadEncrypted=encryption.encrypt(value,binding(conn,previous));
 const changed=await model(conn).findOneAndUpdate({_id:previous._id,state:previous.state,revision:previous.revision,redrives:previous.redrives||0},{$set:{payloadEncrypted,state:'pending',attempts:0,lastRequeuedAt:new Date(),availableAt:new Date(),leaseToken:null,leaseUntil:null,failureCode:null},$inc:{revision:1,redrives:1}},{new:true,session});
 if(!changed)throw Object.assign(new Error('Transfer SMS status changed; reload before retrying'),{status:409});return publicRecord(changed.toObject());
}
module.exports={closeAfterPayout,enqueue,summary,record,validateConfig,processOne,requeue,claimOne,classify,retryDelay,publicRecord,ensureIndexes,binding,mask,MAX_ATTEMPTS};
