'use strict';
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const OutboxEvent=require('../models/OutboxEvent');
const WorkerHeartbeat=require('../models/WorkerHeartbeat');
const PlatformAuditLog=require('../models/PlatformAuditLog');
const {sendMail}=require('../../config/mail');

const TYPES=new Set(['subscription.granted','subscription.revoked']);
const ADDRESS=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WORKER_LEASE_MS=90000; // Longer than the 10s provider timeout; no unbounded handler allowed.
function validPayload(input){
  const to=String(input?.to||'').trim().toLowerCase();
  const tenantName=String(input?.tenantName||'').trim();
  const planName=String(input?.planName||'').trim();
  const expiresAt=input?.expiresAt?new Date(input.expiresAt):undefined;
  if(!ADDRESS.test(to)||to.length>254||!tenantName||tenantName.length>150||planName.length>120||
    (expiresAt&&Number.isNaN(expiresAt.valueOf())))throw new Error('Outbox event requires valid notification metadata');
  return {to,tenantName,planName,...(expiresAt?{expiresAt}:{})};
}
// Must run in the same MongoDB transaction as the business change.
async function enqueue({key,type,tenantId,payload,session},Model=OutboxEvent){
  if(!session)throw new Error('Transactional session required for outbox enqueue');
  if(typeof key!=='string'||!/^[-a-zA-Z0-9_:/.]{8,160}$/.test(key)||!TYPES.has(type)||!mongoose.isValidObjectId(tenantId))
    throw new Error('Unsupported or invalid outbox event');
  const [record]=await Model.create([{eventKey:key,type,tenantId,payload:validPayload(payload),state:'pending',availableAt:new Date()}],{session});
  return record;
}
function buildEmail(job){
  if(!TYPES.has(job?.type))throw new Error('Unsupported event type');
  const p=validPayload(job.payload);
  const name=p.tenantName;
  if(job.type==='subscription.granted'){
    if(!p.expiresAt||!p.planName)throw Object.assign(new Error('Invalid subscription notification payload'),{code:'INVALID_OUTBOX_PAYLOAD'});
    const end=p.expiresAt.toISOString().slice(0,10);
    return {to:p.to,subject:'ClassicFin Hub subscription access updated',text:
      `Your ClassicFin Hub workspace (${name}) subscription access was updated by platform administration.\n\nPlan: ${p.planName}\nAccess term ends (UTC): ${end}\n\nThis notice does not confirm a payment or invoice. Sign in directly to your workspace to review your plan. If you did not expect this change, contact platform support through your existing trusted channel.`};
  }
  return {to:p.to,subject:'ClassicFin Hub subscription access revoked',text:
    `Subscription access for your ClassicFin Hub workspace (${name}) was revoked by platform administration.\n\nSign in directly or contact platform support through your established channel to review this action. This is not a payment or settlement confirmation.`};
}
function retryDelayMs(attempts, random=crypto.randomInt){
  return Math.min(3600000,30000*2**Math.min(7,Math.max(0,attempts-1)))+random(0,10000);
}
function classifyFailure(error){
  const code=error?.providerStatus;
  if(error?.code==='MAIL_NOT_CONFIGURED')return {retryable:false,code:'mail_not_configured'};
  if(error?.code==='INVALID_OUTBOX_PAYLOAD')return {retryable:false,code:'invalid_payload'};
  if(typeof code==='number' && code>=400 && code<500 && code!==408 && code!==429)
    return {retryable:false,code:'provider_permanent_rejection'};
  if(code===429)return {retryable:true,code:'provider_rate_limited'};
  if(error?.name==='AbortError'||error?.name==='TimeoutError')return {retryable:true,code:'provider_timeout'};
  return {retryable:true,code:'delivery_attempt_failed'};
}
async function expireExhausted(now=new Date(),Model=OutboxEvent){
  return Model.updateMany({state:'processing',leaseUntil:{$lte:now},$expr:{$gte:['$attempts','$maxAttempts']}},
    {$set:{state:'dead',failureCode:'lease_expired_after_final_attempt',completedAt:now,leaseToken:null,leaseUntil:null}});
}
async function claim({workerId,now=new Date(),token=crypto.randomUUID(),leaseMs=WORKER_LEASE_MS}={},Model=OutboxEvent){
  if(typeof workerId!=='string'||!workerId||workerId.length>128)throw new Error('Worker identity required');
  if(leaseMs<30000||leaseMs>300000)throw new Error('Invalid worker lease');
  return Model.findOneAndUpdate({$or:[
    {state:'pending',availableAt:{$lte:now},$expr:{$lt:['$attempts','$maxAttempts']}},
    {state:'processing',leaseUntil:{$lte:now},$expr:{$lt:['$attempts','$maxAttempts']}}
  ]},{$set:{state:'processing',workerId,leaseToken:token,leaseUntil:new Date(now.getTime()+leaseMs),failureCode:null},$inc:{attempts:1}},
  {sort:{availableAt:1,createdAt:1},new:true});
}
function owned(job,now=new Date()){
  return {_id:job._id,state:'processing',leaseToken:job.leaseToken,leaseUntil:{$gt:now}};
}
async function accept(job,result,{now=new Date(),Model=OutboxEvent}={}){
  if(!result||result.provider!=='resend'||typeof result.messageId!=='string'||!result.messageId)
    throw new Error('Provider acceptance receipt required');
  const update=await Model.updateOne(owned(job,now),{$set:{state:'accepted',providerAcceptance:{provider:result.provider,messageId:result.messageId,acceptedAt:now},completedAt:now,purgeAt:new Date(now.getTime()+90*86400000),leaseUntil:null,leaseToken:null}});
  return update.modifiedCount===1;
}
async function fail(job,error,{now=new Date(),Model=OutboxEvent,random}={}){
  const info=classifyFailure(error);
  const terminal=!info.retryable||job.attempts>=job.maxAttempts;
  const update=await Model.updateOne(owned(job,now),{$set:{state:terminal?'dead':'pending',
    availableAt:terminal?now:new Date(now.valueOf()+retryDelayMs(job.attempts,random)),
    failureCode:info.code,completedAt:terminal?now:null,leaseToken:null,leaseUntil:null}});
  return {updated:update.modifiedCount===1,state:terminal?'dead':'pending',failureCode:info.code};
}
async function processOne({workerId,Model=OutboxEvent,deliver=sendMail,now=()=>new Date()}={}){
  const job=await claim({workerId,now:now()},Model);
  if(!job)return null;
  try{
    const message=buildEmail(job);
    // Provider idempotency key must be stable across worker crashes and retries.
    const result=await deliver({...message,idempotencyKey:`cfh:${job.eventKey}`});
    const updated=await accept(job,result,{now:now(),Model});
    return {state:updated?'accepted':'lease_lost',eventKey:job.eventKey};
  }catch(error){
    const result=await fail(job,error,{now:now(),Model});
    return {state:result.updated?result.state:'lease_lost',eventKey:job.eventKey,failureCode:result.failureCode};
  }
}
async function metrics({Event=OutboxEvent,Heartbeat=WorkerHeartbeat,now=new Date()}={}){
  const [pending,processing,accepted,dead,recent,workers]=await Promise.all([
    ...['pending','processing','accepted','dead'].map(state=>Event.countDocuments({state})),
    Event.find({}).sort({createdAt:-1}).limit(40).select('-payload -leaseToken -providerAcceptance').lean(),
    Heartbeat.countDocuments({seenAt:{$gte:new Date(now.valueOf()-30000)}})
  ]);
  return {counts:{pending,processing,accepted,dead},recent,liveWorkers:workers};
}
async function retryDead({id,actor,reason,now=new Date(),Event=OutboxEvent,Audit=PlatformAuditLog}={}){
  if(!mongoose.isValidObjectId(id)||!actor?.id||!actor.permissions?.includes('*'))throw Object.assign(new Error('Not permitted'),{status:403});
  reason=String(reason||'').trim();
  if(reason.length<20||reason.length>400)throw Object.assign(new Error('A 20–400-character recovery justification is required'),{status:400});
  const session=await mongoose.startSession();
  try{
    let result;
    await session.withTransaction(async()=>{
      result=await Event.findOneAndUpdate({_id:id,state:'dead'},{$set:{state:'pending',attempts:0,availableAt:now,
        failureCode:null,completedAt:null,leaseToken:null,leaseUntil:null,workerId:null}},{session,new:true});
      if(!result)throw Object.assign(new Error('Only dead-letter events can be retried'),{status:409});
      await Audit.create([{actorId:String(actor.id),actorName:String(actor.name||''),action:'outbox.dead_letter_retried',
        moduleKey:'operations',recordId:String(id),after:{eventType:result.type,reason}}],{session});
    });
    return result;
  }finally{await session.endSession();}
}
module.exports={enqueue,validPayload,buildEmail,retryDelayMs,classifyFailure,expireExhausted,claim,accept,fail,processOne,metrics,retryDead,WORKER_LEASE_MS};
