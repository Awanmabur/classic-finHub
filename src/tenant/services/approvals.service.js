'use strict';
// Independently subscribable internal approval requests. No action executor is
// registered: a completed approval does not move money or override module reviews.
const crypto=require('node:crypto');
const SYSTEM_ACTOR_ID='000000000000000000000000';
const mongoose=require('mongoose');
const {approvalPolicyModel,approvalRequestModel,branchModel,auditEventModel,ensureTenantIndexes}=require('../models');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const mobile=require('./mobileMoney.service');
const ROLES=Object.freeze(['Tenant Owner','Branch Manager','Approval Officer','Reconciliation Officer']);
const CATEGORIES=Object.freeze(['general','procurement','operational_exception','policy_change']);
const STATES=Object.freeze(['pending','approved','rejected','cancelled','expired']);
const OBJECT_ID=/^[0-9a-f]{24}$/i;
const CODE=/^[a-z][a-z0-9_]{2,39}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
function text(value,label,min,max){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)throw fail(`${label} must contain ${min}–${max} characters`);return value.trim();}
function objectId(value){if(!OBJECT_ID.test(String(value||'')))throw fail('Invalid approval identifier',404);return String(value);}
function access(tenant,user,permission){if(!hasModuleForUser(tenant,user,'approval_workflows')||!hasPermission(user,permission))throw fail('Approval module entitlement and user permission required',403);}
function validBranch(user,requested){
 if(user?.role==='Tenant Owner'){return objectId(requested);}
 if(!OBJECT_ID.test(String(user?.branchId||'')))throw fail('Assigned active branch required',403);
 return String(user.branchId); // client cannot select another branch
}
function scope(user){
 if(['Tenant Owner','Auditor'].includes(user?.role))return {};
 if(!OBJECT_ID.test(String(user?.branchId||'')))throw fail('An assigned branch is required',403);
 return {branchId:String(user.branchId)};
}
function policyInput(input){
 const code=String(input?.code||'').trim().toLowerCase();if(!CODE.test(code))throw fail('Policy code must be 3–40 lowercase letters, digits or underscores');
 const name=text(input?.name,'Policy name',3,100),category=String(input?.category||'');if(!CATEGORIES.includes(category))throw fail('Unsupported policy category');
 const steps=Array.isArray(input?.steps)?input.steps:[input?.step1,input?.step2,input?.step3].filter(Boolean);
 if(steps.length<1||steps.length>3||steps.some(r=>!ROLES.includes(r)))throw fail('Choose 1–3 recognized approval roles in order');
 const expiresHours=Number(input?.expiresHours);
 if(!Number.isSafeInteger(expiresHours)||expiresHours<1||expiresHours>720)throw fail('Expiry must be 1–720 hours');
 return {code,name,category,steps:steps.map(role=>({role})),expiresHours};
}
function requestInput(input){
 const policyCode=String(input?.policyCode||'').trim();if(!CODE.test(policyCode))throw fail('Select an active approval policy');
 const subject=text(input?.subject,'Subject',4,120),justification=text(input?.justification,'Justification',15,1000);
 const idempotencyKey=String(input?.idempotencyKey||'').toLowerCase();if(!UUID.test(idempotencyKey))throw fail('A valid unique request key is required');
 return {policyCode,subject,justification,idempotencyKey};
}
function same(existing,actor,branchId,v){return String(existing.requesterId)===String(actor.id)&&String(existing.branchId)===String(branchId)&&existing.policyCode===v.policyCode&&existing.subject===v.subject&&existing.justification===v.justification;}
async function publish(conn,tenant,actor,input){
 access(tenant,actor,'approvals.manage');if(actor.role!=='Tenant Owner')throw fail('Only the Tenant Owner publishes approval policies',403);
 const v=policyInput(input);await ensureTenantIndexes(conn);const session=await conn.startSession();let published;
 try{await session.withTransaction(async()=>{
  const Policy=approvalPolicyModel(conn);
  const latest=await Policy.findOne({code:v.code}).sort({version:-1}).session(session);
  const version=latest?latest.version+1:1;if(version>99999)throw fail('Policy version limit reached',409);
  const active=await Policy.findOne({code:v.code,status:'active'}).session(session);
  if(active)await Policy.updateOne({_id:active._id,status:'active'},{$set:{status:'retired',retiredBy:actor.id,retiredAt:new Date()}},{session});
  [published]=await Policy.create([{...v,version,createdBy:actor.id}],{session});
  await auditEventModel(conn).create([{action:'approvals.policy.published',actorId:actor.id,targetId:published._id,
   metadata:{code:v.code,version,category:v.category,previousVersion:active?.version||null}}],{session});
 });return published;}
 catch(e){if([11000,112].includes(e.code))throw fail('Another administrator changed this policy. Refresh and retry.',409);throw e;}
 finally{await session.endSession();}
}
async function retire(conn,tenant,actor,code){
 access(tenant,actor,'approvals.manage');if(actor.role!=='Tenant Owner')throw fail('Only the Tenant Owner retires policies',403);
 if(!CODE.test(String(code)))throw fail('Invalid policy code');await ensureTenantIndexes(conn);const session=await conn.startSession();let updated;
 try{await session.withTransaction(async()=>{
  updated=await approvalPolicyModel(conn).findOneAndUpdate({code,status:'active'},{$set:{status:'retired',retiredBy:actor.id,retiredAt:new Date()}},{session,new:true});
  if(!updated)throw fail('Active policy not found',404);
  await auditEventModel(conn).create([{action:'approvals.policy.retired',actorId:actor.id,targetId:updated._id,metadata:{code,version:updated.version}}],{session});
 });return updated;}finally{await session.endSession();}
}
async function policies(conn,tenant,actor){access(tenant,actor,'approvals.view');return approvalPolicyModel(conn).find({status:'active'}).sort({name:1}).limit(100).lean();}
async function create(conn,tenant,actor,input){
 access(tenant,actor,'approvals.submit');const v=requestInput(input),branchId=validBranch(actor,input?.branchId);await ensureTenantIndexes(conn);
 const Case=approvalRequestModel(conn),old=await Case.findOne({idempotencyKey:v.idempotencyKey}).lean();
 if(old){if(!same(old,actor,branchId,v))throw fail('Request key already used with different details',409);return {request:old,duplicate:true};}
 const session=await conn.startSession();let request;
 try{await session.withTransaction(async()=>{
  const policy=await approvalPolicyModel(conn).findOne({code:v.policyCode,status:'active'}).session(session);
  if(!policy)throw fail('Policy is no longer available',409);
  const branch=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'active'},{$inc:{revision:1}},{session,new:true});
  if(!branch)throw fail('Assigned branch is inactive',409);
  const now=new Date();
  [request]=await Case.create([{reference:'APR-'+crypto.randomBytes(12).toString('hex').toUpperCase(),
   ...v,branchId,requesterId:actor.id,policyName:policy.name,policyVersion:policy.version,
   category:policy.category,steps:policy.steps.map(s=>s.role),expiresAt:new Date(now.getTime()+policy.expiresHours*3600000)}],{session});
  await auditEventModel(conn).create([{action:'approvals.request.created',actorId:actor.id,targetId:request._id,
   metadata:{branchId,reference:request.reference,policyCode:v.policyCode,policyVersion:policy.version}}],{session});
 });return {request,duplicate:false};}
 catch(e){if(e.code===11000){const sameKey=await Case.findOne({idempotencyKey:v.idempotencyKey}).lean();
  if(sameKey&&same(sameKey,actor,branchId,v))return {request:sameKey,duplicate:true};
  throw fail('Request key already used',409);}throw e;}
 finally{await session.endSession();}
}
function canDecide(actor,request,now=new Date()){
 if(request?.status!=='pending'||new Date(request.expiresAt)<=now||String(request.requesterId)===String(actor?.id))return false;
 if(request.steps?.[request.currentStep]!==actor?.role)return false;
 if(actor.role!=='Tenant Owner'&&String(actor.branchId||'')!==String(request.branchId))return false;
 return !request.decisions?.some(d=>String(d.actorId)===String(actor.id));
}
async function decide(conn,tenant,actor,requestId,input){
 access(tenant,actor,'approvals.decide');const decision=String(input?.decision||'');
 if(!['approve','reject'].includes(decision))throw fail('Invalid approval decision');
 const note=text(input?.note,'Independent review reason',12,400);await ensureTenantIndexes(conn);
 const session=await conn.startSession();let updated;
 try{await session.withTransaction(async()=>{
  const Case=approvalRequestModel(conn),now=new Date();
  const current=await Case.findOne({_id:objectId(requestId),...scope(actor)}).session(session);
  if(!current)throw fail('Approval request is outside your scope',404);
  if(!canDecide(actor,current,now))throw fail('Request expired, already decided, or this reviewer is not independent and assigned',409);
  const completed=decision==='approve'&&current.currentStep===current.steps.length-1;
  const nextStatus=decision==='reject'?'rejected':completed?'approved':'pending';
  updated=await Case.findOneAndUpdate({_id:current._id,status:'pending',revision:current.revision,currentStep:current.currentStep,
   expiresAt:{$gt:now}},{$set:{status:nextStatus,...(nextStatus!=='pending'?{terminalBy:actor.id,terminalAt:now,terminalNote:note}:{})},
   $inc:{currentStep:decision==='approve'?1:0,revision:1},$push:{decisions:{stepIndex:current.currentStep,actorId:actor.id,role:actor.role,decision,note,at:now}}},
   {new:true,session,runValidators:true});
  if(!updated)throw fail('Approval changed concurrently. Refresh and retry.',409);
  await auditEventModel(conn).create([{action:`approvals.request.${nextStatus==='pending'?'step_approved':nextStatus}`,
   actorId:actor.id,targetId:current._id,metadata:{branchId:String(current.branchId),reference:current.reference,
    stepIndex:current.currentStep,decision}}],{session});
  // Optional subscriber notification is committed atomically with the decision.
  // It never executes the approved business action.
  await require('./notification.service').approvalEvent(conn,tenant,updated,current.requesterId,session);
 });return updated;}finally{await session.endSession();}
}
async function cancel(conn,tenant,actor,requestId,input){
 access(tenant,actor,'approvals.view');const note=text(input?.note,'Cancellation reason',12,400);await ensureTenantIndexes(conn);
 const session=await conn.startSession();let updated;
 try{await session.withTransaction(async()=>{
  const current=await approvalRequestModel(conn).findOne({_id:objectId(requestId),...scope(actor)}).session(session);
  if(!current)throw fail('Request not found',404);
  if(new Date(current.expiresAt)<=new Date())throw fail('Expired requests cannot be cancelled; await the expiry sweep',409);
  if(actor.role!=='Tenant Owner'&&String(current.requesterId)!==String(actor.id))throw fail('Only the requester or tenant owner may cancel',403);
  // Do not erase previous approval steps; history is retained.
  updated=await approvalRequestModel(conn).findOneAndUpdate({_id:current._id,status:'pending',revision:current.revision,expiresAt:{$gt:new Date()}},
   {$set:{status:'cancelled',terminalBy:actor.id,terminalAt:new Date(),terminalNote:note},$inc:{revision:1}},{session,new:true});
  if(!updated)throw fail('Request cannot be cancelled in its current state',409);
  await auditEventModel(conn).create([{action:'approvals.request.cancelled',actorId:actor.id,targetId:updated._id,
   metadata:{branchId:String(updated.branchId),reference:updated.reference}}],{session});
 });return updated;}finally{await session.endSession();}
}
async function list(conn,tenant,actor,{status='',cursor=''}={}){
 access(tenant,actor,'approvals.view');if(status&&!STATES.includes(status))throw fail('Invalid approval status');
 const location=mobile.decodeCursor(cursor),filter={...scope(actor),...(status?{status}:{})};
 if(actor.role==='Approval Requester'||['Money Transfer Operator','Forex Operator','Banking Operator','Mobile Money Operator'].includes(actor.role))filter.requesterId=actor.id;
 if(location)filter.$or=[{createdAt:{$lt:location.at}},{createdAt:location.at,_id:{$lt:objectId(location.id)}}];
 const entries=await approvalRequestModel(conn).find(filter).sort({createdAt:-1,_id:-1}).limit(41).lean();const items=entries.slice(0,40);
 return {items,nextCursor:entries.length>40?mobile.encodeCursor(items.at(-1)):null};
}
async function detail(conn,tenant,actor,requestId){
 access(tenant,actor,'approvals.view');const filter={_id:objectId(requestId),...scope(actor)};
 if(actor.role==='Approval Requester'||['Money Transfer Operator','Forex Operator','Banking Operator','Mobile Money Operator'].includes(actor.role))filter.requesterId=actor.id;
 const item=await approvalRequestModel(conn).findOne(filter).lean();if(!item)throw fail('Approval request not found in your scope',404);return item;
}
async function queue(conn,tenant,actor){
 access(tenant,actor,'approvals.decide');if(!ROLES.includes(actor.role))throw fail('No approval role assigned',403);
 return approvalRequestModel(conn).find({...scope(actor),status:'pending',requesterId:{$ne:actor.id},
  'decisions.actorId':{$ne:actor.id},expiresAt:{$gt:new Date()},
  $expr:{$eq:[{$arrayElemAt:['$steps','$currentStep']},actor.role]}}).sort({createdAt:1}).limit(30).lean();
}
async function expireDue(conn,now=new Date(),limit=100){
 if(!(now instanceof Date)||!Number.isFinite(now.getTime())||!Number.isSafeInteger(limit)||limit<1||limit>200)throw fail('Invalid expiry sweep');
 await ensureTenantIndexes(conn);const Case=approvalRequestModel(conn);const due=await Case.find({status:'pending',expiresAt:{$lte:now}}).select('_id').sort({expiresAt:1}).limit(limit).lean();let count=0;
 for(const entry of due){const session=await conn.startSession();try{await session.withTransaction(async()=>{
  const changed=await Case.findOneAndUpdate({_id:entry._id,status:'pending',expiresAt:{$lte:now}},
   {$set:{status:'expired',terminalAt:now,terminalNote:'Expired by system deadline'},$inc:{revision:1}},{new:true,session});
  if(!changed)return;
  await auditEventModel(conn).create([{action:'approvals.request.expired',actorId:SYSTEM_ACTOR_ID,targetId:changed._id,
   metadata:{branchId:String(changed.branchId),reference:changed.reference,systemAction:true}}],{session});count++;
 });}finally{await session.endSession();}}
 return count;
}
module.exports={ROLES,CATEGORIES,STATES,fail,text,objectId,access,validBranch,scope,policyInput,requestInput,canDecide,
 publish,retire,policies,create,decide,cancel,list,detail,queue,expireDue};
