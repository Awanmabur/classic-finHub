'use strict';
// Operational requests ONLY. No disbursement, PIN payout or ledger settlement is
// performed by this service. Provider adapters must be separately verified.
const crypto=require('node:crypto');
const financialAuth=require('./financialAuthorization.service');
const mongoose=require('mongoose');
const mobile=require('./mobileMoney.service');
const {hasModuleForUser,hasPermission,hasModule}=require('./moduleAccess.service');
const {
 transferContactModel,transferOrderModel,branchModel,auditEventModel,ensureTenantIndexes
}=require('../models');
const {reserveUsage}=require('../../platform/services/commercial.service');
const OID=/^[a-f0-9]{24}$/i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
function id(value){if(!OID.test(String(value||'')))throw fail('Invalid record identifier');return String(value);}
function text(value,label,min,max){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)throw fail(`Invalid ${label}`);return value.trim();}
function requireModuleAccess(tenant,actor,permission){
 if(!hasModuleForUser(tenant,actor,'money_transfer')||!hasPermission(actor,permission))throw fail('Money Transfer module or role permission is unavailable',403);
}
function writeActor(actor){return actor?.role==='Tenant Owner'||actor?.role==='Money Transfer Operator';}
function reviewActor(actor){return ['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(actor?.role);}
function branchScope(actor){
 if(['Tenant Owner','Auditor'].includes(actor?.role))return require('./branchView.service').readScope(actor);
 if(!OID.test(String(actor?.branchId||'')))throw fail('Active assigned branch required',403);
 return {branchId:id(actor.branchId)};
}
function recordScope(actor){
 const scope=branchScope(actor);
 if(actor?.role==='Money Transfer Operator')scope.createdBy=id(actor.id);
 return scope;
}
function selectedBranch(actor,input){return require('./transactionBranch.service').assignedBranchId(actor,input);}
function validateContact(input){
 const fullName=text(input?.fullName,'contact name',2,120);
 const phone=text(input?.phone,'international phone number',9,16);
 const country=text(input?.country,'country code',2,2).toUpperCase();
 const kind=input?.kind;
 if(!['sender','beneficiary'].includes(kind)||!require('../../utils/selectionOptions').isCountryCode(country)||!/^\+[1-9]\d{7,14}$/.test(phone))
  throw fail('Provide sender or beneficiary, ISO country code, and E.164 phone beginning with +');
 return {kind,fullName,phone,country};
}
function typedParty(name,phone,country,label){
 if(typeof name==='string'&&/[<>\u0000-\u001f\u007f]/.test(name))throw fail('Enter a valid '+label+' name');
 const cleanName=text(name,label+' name',2,120);
 if(typeof phone==='string'&&/[\u0000-\u001f\u007f]/.test(phone))throw fail('Enter a valid '+label+' international phone');
 const enteredPhone=text(phone,label+' international phone',8,40);
 const rawPhone=enteredPhone.replace(/[ ().-]/g,'');
 const code=text(country,label+' country code',2,2).toUpperCase();
 if(!/^\+[1-9]\d{7,14}$/.test(rawPhone)||!require('../../utils/selectionOptions').isCountryCode(code))throw fail('Use an international phone beginning with + and select a valid '+label+' country');
 return {contactId:null,name:cleanName,phone:rawPhone,country:code};
}
function validateOrder(input){
 const hasTyped=['senderName','senderPhone','senderCountry','receiverName','receiverPhone','receiverCountry'].some(key=>Object.hasOwn(input||{},key));
 const hasIds=['senderId','beneficiaryId'].some(key=>input?.[key]!==undefined&&input[key]!==null&&input[key]!=='');
 if(hasTyped&&hasIds)throw fail('Enter sender and receiver details directly, or use saved contact identifiers; do not combine both');
 let senderId=null,beneficiaryId=null,sender=null,beneficiary=null;
 if(hasTyped){sender=typedParty(input.senderName,input.senderPhone,input.senderCountry,'sender');beneficiary=typedParty(input.receiverName,input.receiverPhone,input.receiverCountry,'receiver');}
 else{senderId=id(input?.senderId);beneficiaryId=id(input?.beneficiaryId);if(senderId===beneficiaryId)throw fail('Sender and beneficiary must be different contacts');}
 const currency=text(input?.currency,'currency',3,3);
 const amountMinor=mobile.toMinor(input?.amount,currency);
 const feeMinor=mobile.toMinor(input?.fee??'0',currency,true);
 if(feeMinor>amountMinor)throw fail('Transfer fee cannot exceed the requested amount');
 const idempotencyKey=text(input?.idempotencyKey,'form reference',36,36);
 if(!UUID.test(idempotencyKey))throw fail('Invalid form reference. Reload the page.');
 const validDays=Number(input?.validDays??7);
 if(!Number.isSafeInteger(validDays)||validDays<1||validDays>30)throw fail('Validity must be 1–30 days');
 return {partyEntryMode:hasTyped?'typed':'saved_contact',senderId,beneficiaryId,sender,beneficiary,currency,amountMinor,feeMinor,idempotencyKey,validDays,capture:require('./operationCapture.service').parse('money_transfer',input)};
}
function snapshot(contact){return {contactId:contact._id,name:contact.fullName,phone:contact.phone,country:contact.country};}
function maskPhone(phone){return String(phone).replace(/.(?=.{4})/g,'•');}
function equivalent(existing,actor,branchId,v){
 const mode=v.partyEntryMode||'saved_contact',storedMode=existing.partyEntryMode||'saved_contact';
 const parties=mode==='typed'?['sender','beneficiary'].every(key=>['name','phone','country'].every(field=>existing[key]?.[field]===v[key]?.[field])):
  String(existing.sender.contactId)===v.senderId&&String(existing.beneficiary.contactId)===v.beneficiaryId;
 return String(existing.createdBy)===String(actor.id)&&String(existing.branchId)===branchId&&
   mode===storedMode&&parties&&
   require('./operationCapture.service').equivalent('money_transfer',existing.capture,v.capture)&&existing.currency===v.currency&&String(existing.amountMinor)===String(v.amountMinor)&&
   String(existing.feeMinor)===String(v.feeMinor)&&existing.validDays===v.validDays;
}
async function addContact(conn,tenant,actor,input){
 requireModuleAccess(tenant,actor,'money_transfer.contacts');
 if(!writeActor(actor))throw fail('This role cannot manage contacts',403);
 const values=validateContact(input),branchId=String((await require('./transactionBranch.service').resolveTransactionBranch(conn,actor,input))._id);
 await ensureTenantIndexes(conn);
 const tx=await conn.startSession();let created;
 try{await tx.withTransaction(async()=>{
  const authorization=await financialAuth.fenceAction(conn,tx,actor,tenant,'money_transfer','money_transfer.contacts',{branchId});
   const branch=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'active'},{$inc:{revision:1}},{session:tx,new:true});
   if(!branch)throw fail('Branch is inactive or unavailable',409);
   [created]=await transferContactModel(conn).create([{...values,branchId,createdBy:actor.id,updatedBy:actor.id}],{session:tx});
   await auditEventModel(conn).create([{action:'money_transfer.contact.created',actorId:actor.id,targetId:created._id,
    metadata:{branchId,kind:values.kind}}],{session:tx});
 });return created;}finally{await tx.endSession();}
}
async function updateContact(conn,tenant,actor,contactId,input){
 requireModuleAccess(tenant,actor,'money_transfer.contacts');
 if(!writeActor(actor))throw fail('This role cannot manage contacts',403);
 const values=validateContact(input),filter={_id:id(contactId),...branchScope(actor)};
 await ensureTenantIndexes(conn);const tx=await conn.startSession();let updated;
 try{await tx.withTransaction(async()=>{
  const authorization=await financialAuth.fenceAction(conn,tx,actor,tenant,'money_transfer','money_transfer.contacts');
   const existing=await transferContactModel(conn).findOne(filter).session(tx);
   if(!existing)throw fail('Contact outside your assigned branch',404);
   if(existing.kind!==values.kind)throw fail('Contact type cannot be changed',409);
   updated=await transferContactModel(conn).findOneAndUpdate({...filter,revision:existing.revision},
    {$set:{fullName:values.fullName,phone:values.phone,country:values.country,updatedBy:actor.id},$inc:{revision:1}},
    {session:tx,new:true});
   if(!updated)throw fail('Contact was updated concurrently',409);
   await auditEventModel(conn).create([{action:'money_transfer.contact.updated',actorId:actor.id,targetId:updated._id,
    metadata:{branchId:String(updated.branchId),kind:updated.kind,revision:updated.revision}}],{session:tx});
 });return updated;}finally{await tx.endSession();}
}
async function archiveContact(conn,tenant,actor,contactId){
 requireModuleAccess(tenant,actor,'money_transfer.contacts');if(!writeActor(actor))throw fail('Contact administration unavailable',403);
 await ensureTenantIndexes(conn);const tx=await conn.startSession();let updated;
 try{await tx.withTransaction(async()=>{
  const authorization=await financialAuth.fenceAction(conn,tx,actor,tenant,'money_transfer','money_transfer.contacts');
  updated=await transferContactModel(conn).findOneAndUpdate({_id:id(contactId),active:true,...branchScope(actor)},
   {$set:{active:false,updatedBy:actor.id},$inc:{revision:1}},{session:tx,new:true});
  if(!updated)throw fail('Contact not found or already archived',404);
  await auditEventModel(conn).create([{action:'money_transfer.contact.archived',actorId:actor.id,targetId:updated._id,
   metadata:{branchId:String(updated.branchId),kind:updated.kind}}],{session:tx});
 });return updated;}finally{await tx.endSession();}
}
async function listContacts(conn,tenant,actor,{kind=null,branchId=null}={}){
 requireModuleAccess(tenant,actor,'money_transfer.view');
 const scope=branchScope(actor);
 if(branchId){id(branchId);if(scope.branchId&&String(scope.branchId)!==String(branchId))throw fail('Cross-branch contact access denied',403);scope.branchId=branchId;}
 const query={...scope,...(kind?{kind}:{}),active:true};
 if(kind&&!['sender','beneficiary'].includes(kind))throw fail('Invalid contact type');
 return transferContactModel(conn).find(query).select('fullName phone country kind branchId active').sort({fullName:1,_id:1}).limit(500).lean();
}
async function createRequest(conn,tenant,actor,input){
 requireModuleAccess(tenant,actor,'money_transfer.create');if(!writeActor(actor))throw fail('Only transfer operators can request transfers',403);
 const v=validateOrder(input),branchId=String((await require('./transactionBranch.service').resolveTransactionBranch(conn,actor,input))._id);
 await ensureTenantIndexes(conn);
 const Model=transferOrderModel(conn);
 const existing=await Model.findOne({idempotencyKey:v.idempotencyKey}).lean();
 if(existing){if(!equivalent(existing,actor,branchId,v))throw fail('Form reference reused with different details',409);return {order:existing,duplicate:true};}
 const tx=await conn.startSession();let created;
 try{await tx.withTransaction(async()=>{
  const authorization=await financialAuth.fenceAction(conn,tx,actor,tenant,'money_transfer','money_transfer.create',{branchId});
  const branch=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'active'},{$inc:{revision:1}},{session:tx,new:true});
  if(!branch||branch.currency!==v.currency)throw fail('Branch is inactive or has a different currency',409);
  let sender=v.sender,beneficiary=v.beneficiary;
  if(v.partyEntryMode==='saved_contact'){
   const contacts=await transferContactModel(conn).find({_id:{$in:[v.senderId,v.beneficiaryId]},branchId,active:true}).session(tx).lean();
   const savedSender=contacts.find(c=>String(c._id)===v.senderId&&c.kind==='sender'),savedBeneficiary=contacts.find(c=>String(c._id)===v.beneficiaryId&&c.kind==='beneficiary');
   if(!savedSender||!savedBeneficiary)throw fail('Choose active sender and beneficiary contacts from the same branch',409);
   sender=snapshot(savedSender);beneficiary=snapshot(savedBeneficiary);
  }
  await reserveUsage(authorization.tenant,'money_transfer_requests',tx);
  [created]=await Model.create([{reference:`TR-${crypto.randomBytes(12).toString('hex').toUpperCase()}`,
   idempotencyKey:v.idempotencyKey,branchId,createdBy:actor.id,partyEntryMode:v.partyEntryMode,sender,beneficiary,
   capture:v.capture,currency:v.currency,amountMinor:String(v.amountMinor),feeMinor:String(v.feeMinor),validDays:v.validDays,
   expiresAt:new Date(Date.now()+v.validDays*86400000),status:'requested'}],{session:tx});
  await auditEventModel(conn).create([{action:'money_transfer.request.created',actorId:actor.id,targetId:created._id,
   metadata:{branchId,currency:v.currency,reference:created.reference,amountMinor:v.amountMinor}}],{session:tx});
 });return {order:created,duplicate:false};}
 catch(e){if(e.code===11000){const duplicate=await Model.findOne({idempotencyKey:v.idempotencyKey}).lean();
  if(duplicate&&equivalent(duplicate,actor,branchId,v))return {order:duplicate,duplicate:true};
  throw fail('Transfer request reference already in use',409);}throw e;}finally{await tx.endSession();}
}
function decisionNote(value){return text(value,'decision reason',12,400);}
async function decide(conn,tenant,actor,orderId,input){
 requireModuleAccess(tenant,actor,'money_transfer.review');
 if(!reviewActor(actor))throw fail('Only independent transfer reviewers may decide',403);
 const decision=input?.decision;if(!['approve','reject'].includes(decision))throw fail('Invalid review decision');
 const reason=decisionNote(input?.note);await ensureTenantIndexes(conn);
 const tx=await conn.startSession();let updated;
 try{await tx.withTransaction(async()=>{
  const authorization=await financialAuth.fenceAction(conn,tx,actor,tenant,'money_transfer','money_transfer.review');
  updated=await transferOrderModel(conn).findOneAndUpdate({_id:id(orderId),status:'requested',createdBy:{$ne:actor.id},
    expiresAt:{$gt:new Date()},...branchScope(actor)},
   {$set:{status:decision==='approve'?'approved_pending_provider':'rejected',reviewedBy:actor.id,
    reviewedAt:new Date(),reviewNote:reason},$inc:{revision:1}}, {session:tx,new:true});
  if(!updated)throw fail('Request unavailable, expired, self-reviewed or already decided',409);
  await auditEventModel(conn).create([{action:`money_transfer.request.${decision==='approve'?'approved':'rejected'}`,
    actorId:actor.id,targetId:updated._id,metadata:{branchId:String(updated.branchId),reference:updated.reference}}],{session:tx});
 });return updated;}finally{await tx.endSession();}
}
async function cancel(conn,tenant,actor,orderId,input){
 requireModuleAccess(tenant,actor,'money_transfer.view');
 const reason=decisionNote(input?.note);await ensureTenantIndexes(conn);
 const tx=await conn.startSession();let updated;
 try{await tx.withTransaction(async()=>{
  const authorization=await financialAuth.fenceAction(conn,tx,actor,tenant,'money_transfer','money_transfer.view');
  updated=await transferOrderModel(conn).findOneAndUpdate({_id:id(orderId),status:'requested',
   ...(actor.role==='Tenant Owner'?{}:{createdBy:id(actor.id)}),...branchScope(actor)},
   {$set:{status:'cancelled',cancelledBy:actor.id,cancelledAt:new Date(),cancelReason:reason},$inc:{revision:1}},
   {session:tx,new:true});
  if(!updated)throw fail('Only the originator or Tenant Owner can cancel an undecided request',409);
  await auditEventModel(conn).create([{action:'money_transfer.request.cancelled',actorId:actor.id,targetId:updated._id,
   metadata:{branchId:String(updated.branchId),reference:updated.reference}}],{session:tx});
 });return updated;}finally{await tx.endSession();}
}
async function expireDue(conn,now=new Date(),limit=100){
 if(!(now instanceof Date)||!Number.isFinite(now.getTime())||!Number.isSafeInteger(limit)||limit<1||limit>200)throw fail('Invalid expiry job arguments');
 await ensureTenantIndexes(conn);
 const Model=transferOrderModel(conn),Audit=auditEventModel(conn);
 const due=await Model.find({status:{$in:['requested','approved_pending_provider']},expiresAt:{$lte:now}}).select('_id').sort({expiresAt:1,_id:1}).limit(limit).lean();
 let expired=0;
 for(const item of due){
  const tx=await conn.startSession();try{await tx.withTransaction(async()=>{
   const updated=await Model.findOneAndUpdate({_id:item._id,status:{$in:['requested','approved_pending_provider']},expiresAt:{$lte:now}},
    {$set:{status:'expired',expiredAt:now},$inc:{revision:1}},{session:tx,new:true});
   if(!updated)return;
   await Audit.create([{action:'money_transfer.request.expired',actorId:new mongoose.Types.ObjectId('000000000000000000000000'),targetId:updated._id,
    metadata:{branchId:String(updated.branchId),reference:updated.reference,system:true,trigger:'scheduled_expiration'}}],{session:tx});expired++;
  });}finally{await tx.endSession();}
 }
 return {expired,scanned:due.length};
}
async function list(conn,tenant,actor,{cursor=null,status=null}={}){
 requireModuleAccess(tenant,actor,'money_transfer.view');
 if(status&&!['requested','approved_pending_provider','collected_manual','paid_out_manual','rejected','cancelled','expired'].includes(status))throw fail('Invalid transfer status');
 const position=mobile.decodeCursor(cursor),query={...recordScope(actor),...(status?{status}:{})};
 if(position)query.$or=[{createdAt:{$lt:position.at}},{createdAt:position.at,_id:{$lt:id(position.id)}}];
 const found=await transferOrderModel(conn).find(query).sort({createdAt:-1,_id:-1}).limit(41).lean();
 const items=found.slice(0,40);return {items,nextCursor:found.length>40?mobile.encodeCursor(items.at(-1)):null};
}
async function detail(conn,tenant,actor,orderId){
 requireModuleAccess(tenant,actor,'money_transfer.view');
 const order=await transferOrderModel(conn).findOne({_id:id(orderId),...recordScope(actor)}).lean();
 if(!order)throw fail('Transfer request not found in your authorized scope',404);
 return order;
}
async function reviewQueue(conn,tenant,actor){
 requireModuleAccess(tenant,actor,'money_transfer.review');if(!reviewActor(actor))throw fail('Review permission required',403);
 return transferOrderModel(conn).find({status:'requested',createdBy:{$ne:id(actor.id)},expiresAt:{$gt:new Date()},...branchScope(actor)})
  .sort({createdAt:1}).limit(30).lean();
}
async function reportRows({conn,filters,scope}){
 const query={createdAt:mobile.dateBounds({from:filters.from,to:filters.to}),...(scope.branchId?{branchId:new mongoose.Types.ObjectId(id(scope.branchId))}:{}),
  ...(scope.operatorId?{createdBy:new mongoose.Types.ObjectId(id(scope.operatorId))}:{})};
 const rows=await transferOrderModel(conn).aggregate([{$match:query},{$group:{_id:{currency:'$currency',status:'$status'},
  count:{$sum:1},amount:{$sum:'$amountMinor'},fees:{$sum:'$feeMinor'}}},{$sort:{'_id.currency':1,'_id.status':1}},{$limit:501}]);
 if(rows.length>500)throw fail('Too many transfer report groups',422);
 return rows.map(r=>({module:'Money Transfer',activity:'Internal transfer requests',status:r._id.status,currency:r._id.currency,
  count:r.count,amountMinor:r.amount?.toString()||'0',feesMinor:r.fees?.toString()||'0',
  volume:mobile.formatMoneyMinor(r.amount?.toString()||'0',r._id.currency),fees:mobile.formatMoneyMinor(r.fees?.toString()||'0',r._id.currency)}));
}
const unavailable=require('../../utils/unavailableOperation');
// Old direct payout entrypoints must remain explicitly blocked.
const sendMoney=()=>unavailable('moneyTransfer sendMoney');
const payoutByPin=()=>unavailable('moneyTransfer payoutByPin');
module.exports={sendMoney,payoutByPin,fail,id,selectedBranch,validateContact,validateOrder,branchScope,recordScope,maskPhone,equivalent,
 addContact,updateContact,archiveContact,listContacts,createRequest,decide,cancel,expireDue,list,detail,reviewQueue,reportRows};
