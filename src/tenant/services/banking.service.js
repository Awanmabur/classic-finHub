'use strict';
// Banking request management, not deposit taking or bank execution.
// A bank's actual balances and settled movements are NEVER inferred here.
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const mobile=require('./mobileMoney.service');
const {hasPermission,hasModuleForUser}=require('./moduleAccess.service');
const {bankReferenceModel,bankingRequestModel,branchModel,auditEventModel,ensureTenantIndexes}=require('../models');
const {reserveUsage}=require('../../platform/services/commercial.service');
const OID=/^[a-f0-9]{24}$/i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
function id(value){if(!OID.test(String(value||'')))throw fail('Invalid identifier');return String(value);}
function text(value,label,min=1,max=120){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)throw fail(`Invalid ${label}`);return value.trim();}
function moduleAccess(tenant,actor,permission){
 if(!hasModuleForUser(tenant,actor,'banking')||!hasPermission(actor,permission))throw fail('Banking module or role permission unavailable',403);
}
const operator=actor=>['Tenant Owner','Banking Operator'].includes(actor?.role);
const reviewer=actor=>['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(actor?.role);
function branchScope(actor){
 if(['Tenant Owner','Auditor'].includes(actor?.role))return {};
 if(!OID.test(String(actor?.branchId||'')))throw fail('Active assigned branch required',403);
 return {branchId:id(actor.branchId)};
}
function requestScope(actor){
 const scope=branchScope(actor);
 if(actor?.role==='Banking Operator')scope.createdBy=id(actor.id);
 return scope;
}
function branchFor(actor,input){
 const branchId=actor?.role==='Tenant Owner'?input?.branchId:actor?.branchId;
 if(!OID.test(String(branchId||'')))throw fail('Choose an active assigned branch');
 if(actor?.role!=='Tenant Owner'&&String(branchId)!==String(actor.branchId))throw fail('Cross-branch operation forbidden',403);
 return id(branchId);
}
function validateReference(input){
 const customerName=text(input?.customerName,'customer name',2,120);
 const institutionName=text(input?.institutionName,'bank institution',2,120);
 const last4=text(input?.last4,'last four account characters',4,4);
 if(!/^[A-Za-z0-9]{4}$/.test(last4))throw fail('Enter only the last four account characters');
 const currency=text(input?.currency,'currency',3,3);
 if(!['UGX','KES'].includes(currency))throw fail('Unsupported currency');
 return {customerName,institutionName,last4,currency};
}
function validateRequest(input){
 const kind=text(input?.kind,'request kind',8,24);
 if(!['deposit_request','withdrawal_request','transfer_request'].includes(kind))throw fail('Invalid banking operation');
 const sourceId=id(input?.sourceId);
 const destinationId=kind==='transfer_request'?id(input?.destinationId):null;
 if(destinationId===sourceId)throw fail('Source and destination must differ');
 if(kind!=='transfer_request'&&input?.destinationId)throw fail('Destination only applies to transfers');
 const currency=text(input?.currency,'currency',3,3);
 const amountMinor=mobile.toMinor(input?.amount,currency);
 const note=text(input?.note,'request reason',12,400);
 const validDays=Number(input?.validDays??7);
 if(!Number.isSafeInteger(validDays)||validDays<1||validDays>30)throw fail('Request expiry must be 1–30 days');
 const idempotencyKey=text(input?.idempotencyKey,'form reference',36,36);
 if(!UUID.test(idempotencyKey))throw fail('Reload the form to generate a valid reference');
 return {kind,sourceId,destinationId,currency,amountMinor,note,idempotencyKey,validDays};
}
function snapshot(reference){return {referenceId:reference._id,customerName:reference.customerName,institutionName:reference.institutionName,last4:reference.last4};}
function sameRequest(existing,actor,branchId,v){return String(existing.createdBy)===String(actor.id)&&String(existing.branchId)===branchId&&
 existing.kind===v.kind&&String(existing.source.referenceId)===v.sourceId&&String(existing.destination?.referenceId||'')===String(v.destinationId||'')&&
 existing.currency===v.currency&&String(existing.amountMinor)===String(v.amountMinor)&&existing.note===v.note&&existing.validDays===v.validDays;}
async function createReference(conn,tenant,actor,input){
 moduleAccess(tenant,actor,'banking.accounts.manage');if(!operator(actor))throw fail('Bank references may only be maintained by banking staff',403);
 const value=validateReference(input),branchId=branchFor(actor,input);
 await ensureTenantIndexes(conn);
 const session=await conn.startSession();let created;
 try{await session.withTransaction(async()=>{
  const branch=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'active',currency:value.currency},{$inc:{revision:1}},{session,new:true});
  if(!branch)throw fail('Active branch and account currency must agree',409);
  [created]=await bankReferenceModel(conn).create([{...value,branchId,createdBy:actor.id,updatedBy:actor.id}],{session});
  await auditEventModel(conn).create([{action:'banking.reference.created',actorId:actor.id,targetId:created._id,
   metadata:{branchId,currency:value.currency}}],{session});
 });return created;}finally{await session.endSession();}
}
async function updateReference(conn,tenant,actor,referenceId,input){
 moduleAccess(tenant,actor,'banking.accounts.manage');if(!operator(actor))throw fail('Bank reference administration unavailable',403);
 const value=validateReference(input);await ensureTenantIndexes(conn);
 const session=await conn.startSession();let updated;
 try{await session.withTransaction(async()=>{
  const old=await bankReferenceModel(conn).findOne({_id:id(referenceId),status:'active',...branchScope(actor)}).session(session);
  if(!old)throw fail('Bank reference not found in assigned branch',404);
  if(value.currency!==old.currency)throw fail('Currency is immutable; register a separate reference',409);
  updated=await bankReferenceModel(conn).findOneAndUpdate({_id:old._id,status:'active',revision:old.revision},
   {$set:{customerName:value.customerName,institutionName:value.institutionName,last4:value.last4,updatedBy:actor.id},$inc:{revision:1}},
   {session,new:true});
  if(!updated)throw fail('Bank reference changed concurrently',409);
  await auditEventModel(conn).create([{action:'banking.reference.updated',actorId:actor.id,targetId:updated._id,
   metadata:{branchId:String(updated.branchId),revision:updated.revision}}],{session});
 });return updated;}finally{await session.endSession();}
}
async function archiveReference(conn,tenant,actor,referenceId){
 moduleAccess(tenant,actor,'banking.accounts.manage');if(!operator(actor))throw fail('Bank reference administration unavailable',403);
 await ensureTenantIndexes(conn);const session=await conn.startSession();let updated;
 try{await session.withTransaction(async()=>{
  updated=await bankReferenceModel(conn).findOneAndUpdate({_id:id(referenceId),status:'active',...branchScope(actor)},
   {$set:{status:'archived',updatedBy:actor.id},$inc:{revision:1}},{session,new:true});
  if(!updated)throw fail('Bank reference not found or already archived',404);
  await auditEventModel(conn).create([{action:'banking.reference.archived',actorId:actor.id,targetId:updated._id,
   metadata:{branchId:String(updated.branchId)}}],{session});
 });return updated;}finally{await session.endSession();}
}
async function listReferences(conn,tenant,actor,{branchId=null}={}){
 moduleAccess(tenant,actor,'banking.view');const scope=branchScope(actor);
 if(branchId){id(branchId);if(scope.branchId&&scope.branchId!==String(branchId))throw fail('Cross-branch reference access',403);scope.branchId=branchId;}
 return bankReferenceModel(conn).find({status:'active',...scope}).sort({customerName:1,_id:1}).limit(500).lean();
}
async function createRequest(conn,tenant,actor,input){
 moduleAccess(tenant,actor,'banking.requests.create');if(!operator(actor))throw fail('Banking request permission denied',403);
 const value=validateRequest(input),branchId=branchFor(actor,input);
 await ensureTenantIndexes(conn);const Model=bankingRequestModel(conn);
 const existing=await Model.findOne({idempotencyKey:value.idempotencyKey}).lean();
 if(existing){if(!sameRequest(existing,actor,branchId,value))throw fail('Form reference reused with different details',409);return {order:existing,duplicate:true};}
 const session=await conn.startSession();let order;
 try{await session.withTransaction(async()=>{
  const branch=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'active',currency:value.currency},{$inc:{revision:1}},{session,new:true});
  if(!branch)throw fail('Branch unavailable or currency does not match',409);
  // Write-fence each reference: concurrent archive/edit cannot race request
  // creation and silently change the identity the operator just selected.
  const Ref=bankReferenceModel(conn);
  const source=await Ref.findOneAndUpdate({_id:value.sourceId,branchId,currency:value.currency,status:'active'},
   {$inc:{revision:1}},{session,new:true});
  const dest=value.destinationId?await Ref.findOneAndUpdate({_id:value.destinationId,branchId,currency:value.currency,status:'active'},
   {$inc:{revision:1}},{session,new:true}):null;
  if(!source||(value.destinationId&&!dest))throw fail('Select active account references in the same branch and currency',409);
  await reserveUsage(tenant,'banking_requests',session);
  [order]=await Model.create([{reference:`BK-${crypto.randomBytes(12).toString('hex').toUpperCase()}`,
   idempotencyKey:value.idempotencyKey,branchId,createdBy:actor.id,kind:value.kind,source:snapshot(source),
   destination:dest?snapshot(dest):null,currency:value.currency,amountMinor:String(value.amountMinor),note:value.note,validDays:value.validDays,
   expiresAt:new Date(Date.now()+value.validDays*86400000),status:'requested'}],{session});
  await auditEventModel(conn).create([{action:'banking.request.created',actorId:actor.id,targetId:order._id,
   metadata:{branchId,kind:value.kind,currency:value.currency,reference:order.reference,amountMinor:value.amountMinor}}],{session});
 });return {order,duplicate:false};}
 catch(e){if(e.code===11000){const found=await Model.findOne({idempotencyKey:value.idempotencyKey}).lean();
  if(found&&sameRequest(found,actor,branchId,value))return {order:found,duplicate:true};
  throw fail('Request reference already used',409);}throw e;}finally{await session.endSession();}
}
async function decide(conn,tenant,actor,requestId,input){
 moduleAccess(tenant,actor,'banking.review');if(!reviewer(actor))throw fail('Independent reviewer role required',403);
 const decision=input?.decision;if(!['approve','reject'].includes(decision))throw fail('Invalid review decision');
 const note=text(input?.note,'review rationale',12,400);await ensureTenantIndexes(conn);
 const session=await conn.startSession();let updated;
 try{await session.withTransaction(async()=>{
  updated=await bankingRequestModel(conn).findOneAndUpdate({_id:id(requestId),status:'requested',createdBy:{$ne:id(actor.id)},expiresAt:{$gt:new Date()},...branchScope(actor)},
   {$set:{status:decision==='approve'?'approved_pending_bank':'rejected',reviewedBy:actor.id,reviewedAt:new Date(),reviewNote:note},$inc:{revision:1}},
   {session,new:true});
  if(!updated)throw fail('Request already decided, outside your branch or submitted by yourself',409);
  await auditEventModel(conn).create([{action:`banking.request.${decision==='approve'?'approved':'rejected'}`,
   actorId:actor.id,targetId:updated._id,metadata:{branchId:String(updated.branchId),reference:updated.reference}}],{session});
 });return updated;}finally{await session.endSession();}
}
async function cancel(conn,tenant,actor,requestId,input){
 moduleAccess(tenant,actor,'banking.view');const note=text(input?.note,'cancellation rationale',12,400);await ensureTenantIndexes(conn);
 const session=await conn.startSession();let updated;
 try{await session.withTransaction(async()=>{
  updated=await bankingRequestModel(conn).findOneAndUpdate({_id:id(requestId),status:'requested',...branchScope(actor),
   ...(actor.role==='Tenant Owner'?{}:{createdBy:id(actor.id)})},
   {$set:{status:'cancelled',cancelledBy:actor.id,cancelledAt:new Date(),cancelReason:note},$inc:{revision:1}},
   {session,new:true});
  if(!updated)throw fail('Only the originator or tenant owner can cancel an undecided request',409);
  await auditEventModel(conn).create([{action:'banking.request.cancelled',actorId:actor.id,targetId:updated._id,
   metadata:{branchId:String(updated.branchId),reference:updated.reference}}],{session});
 });return updated;}finally{await session.endSession();}
}
async function list(conn,tenant,actor,{status=null,cursor=null}={}){
 moduleAccess(tenant,actor,'banking.view');
 if(status&&!['requested','approved_pending_bank','rejected','cancelled','expired'].includes(status))throw fail('Invalid request status');
 const position=mobile.decodeCursor(cursor);const query={...requestScope(actor),...(status?{status}:{})};
 if(position)query.$or=[{createdAt:{$lt:position.at}},{createdAt:position.at,_id:{$lt:id(position.id)}}];
 const found=await bankingRequestModel(conn).find(query).sort({createdAt:-1,_id:-1}).limit(41).lean();
 const items=found.slice(0,40);
 return {items,nextCursor:found.length>40?mobile.encodeCursor(items.at(-1)):null};
}
async function detail(conn,tenant,actor,requestId){
 moduleAccess(tenant,actor,'banking.view');
 const found=await bankingRequestModel(conn).findOne({_id:id(requestId),...requestScope(actor)}).lean();
 if(!found)throw fail('Banking request not found in authorized scope',404);return found;
}
async function reviewQueue(conn,tenant,actor){
 moduleAccess(tenant,actor,'banking.review');if(!reviewer(actor))throw fail('Review role required',403);
 return bankingRequestModel(conn).find({status:'requested',createdBy:{$ne:id(actor.id)},expiresAt:{$gt:new Date()},...branchScope(actor)}).sort({createdAt:1}).limit(30).lean();
}
async function reportRows({conn,filters,scope}){
 const query={createdAt:mobile.dateBounds({from:filters.from,to:filters.to}),...(scope.branchId?{branchId:new mongoose.Types.ObjectId(id(scope.branchId))}:{})};
 const rows=await bankingRequestModel(conn).aggregate([{$match:query},{$group:{_id:{currency:'$currency',status:'$status',kind:'$kind'},
  count:{$sum:1},amount:{$sum:'$amountMinor'}}},{$sort:{'_id.currency':1,'_id.kind':1,'_id.status':1}},{$limit:501}]);
 if(rows.length>500)throw fail('Too many banking report groups',422);
 return rows.map(r=>({module:'Banking',activity:r._id.kind.replaceAll('_',' '),status:r._id.status,currency:r._id.currency,
  count:r.count,volume:mobile.formatMoneyMinor(r.amount?.toString()||'0',r._id.currency),fees:mobile.formatMoneyMinor('0',r._id.currency)}));
}
async function expireDue(conn,now=new Date(),limit=100){
 if(!(now instanceof Date)||!Number.isFinite(now.getTime())||!Number.isSafeInteger(limit)||limit<1||limit>200)
  throw fail('Invalid expiry sweep parameters');
 await ensureTenantIndexes(conn);
 const due=await bankingRequestModel(conn).find({status:'requested',expiresAt:{$lte:now}}).select('_id').sort({expiresAt:1,_id:1}).limit(limit).lean();
 let expired=0;
 for(const item of due){
  const session=await conn.startSession();
  try{await session.withTransaction(async()=>{
   const changed=await bankingRequestModel(conn).findOneAndUpdate({_id:item._id,status:'requested',expiresAt:{$lte:now}},
    {$set:{status:'expired',expiredAt:now},$inc:{revision:1}},{session,new:true});
   if(!changed)return;
   await auditEventModel(conn).create([{action:'banking.request.expired',actorId:new mongoose.Types.ObjectId('000000000000000000000000'),
    targetId:changed._id,metadata:{branchId:String(changed.branchId),reference:changed.reference,system:true}}],{session});
   expired++;
  });}finally{await session.endSession();}
 }
 return {expired,scanned:due.length};
}
const unavailable=require('../../utils/unavailableOperation');
// Old direct deposit/withdraw endpoints remain fail-closed. They are not aliases
// for request submission: a request cannot silently be treated as a deposit.
const deposit=()=>unavailable('banking deposit');
const withdraw=()=>unavailable('banking withdraw');
module.exports={fail,id,text,moduleAccess,operator,reviewer,branchScope,requestScope,branchFor,validateReference,validateRequest,
 sameRequest,createReference,updateReference,archiveReference,listReferences,createRequest,decide,cancel,expireDue,list,detail,reviewQueue,reportRows,deposit,withdraw};
