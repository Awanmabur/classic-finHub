'use strict';
// Cash refunds are a compensating FINANCIAL transaction, never an edit to
// original collection history. No bank/wallet or external-provider refunds.
// Posting is gated independently of the cross-currency collection feature.
const crypto=require('node:crypto');
const core=require('../models');
const funded=require('../funded/models');
const treasury=require('../treasury/service');
const sms=require('../transferSms/service');
const {model,ensure}=require('./models');
const auth=require('../services/financialAuthorization.service');
const {hasModuleForUser,hasPermission}=require('../services/moduleAccess.service');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const {formatMoneyMinor}=require('../services/mobileMoney.service');
const OID=/^[a-f0-9]{24}$/i,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(message,status=409){return Object.assign(new Error(message),{status});}
function id(value){if(!OID.test(String(value||'')))throw fail('Invalid refund record identifier',400);return String(value);}
function string(value,label,min,max){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||
 /[<>\u0000-\u001f\u007f]/.test(value))throw fail('Invalid '+label,400);return value.trim();}
function assertTenant(conn,tenant){if(!tenant?.slug||!tenant?._id||tenant.dbName!==conn?.name||
 conn.name!==tenantDbNameFromSlug(tenant.slug))throw fail('Refund belongs to another tenant database',403);}
function feature(){if(process.env.CLASSICFIN_LINKED_CURRENCY_REFUNDS!=='enabled')
 throw fail('Customer cash refunds are not enabled on this deployment',403);}
function cashMethod(source,collection){
 if((source.capture?.method||'Cash')!=='Cash'||collection?.sourceType!=='money_transfer'||
  collection.action!=='transfer_collect'||collection.status!=='posted_manual'||
  String(collection.sourceId)!==String(source._id)||String(collection.branchId)!==String(source.branchId)||
  String(source.manualCollectionExecutionId)!==String(collection._id)||
  !collection.accounts?.collectionAccountId||!collection.accounts?.clearingAccountId||
  String(collection.createdBy)!==String(source.createdBy))
  throw fail('Only the exact original cashier cash collection is eligible for a cash refund');
 if(!/^(?:0|[1-9]\d{0,17})$/.test(String(source.amountMinor))||
  !/^(?:0|[1-9]\d{0,17})$/.test(String(source.feeMinor))||
  BigInt(String(source.amountMinor))<=0n)
  throw fail('Original sender principal and fee are not valid refundable cash');
 return {
  principalMinor:String(source.amountMinor),feeMinor:String(source.feeMinor),
  totalMinor:String(BigInt(String(source.amountMinor))+BigInt(String(source.feeMinor))),
  currency:source.currency,cashAccountId:String(collection.accounts.collectionAccountId)
 };
}
async function sourceChecks(conn,session,tenant,source,collection){
 const Payout=funded.models(conn);
 if(await Payout.execution.exists({sourceType:'money_transfer',sourceId:source._id,
  action:'transfer_payout',status:{$in:['pending_review','posted_manual']}}).session(session))
  throw fail('An existing payout is awaiting review or has been posted. Resolve it before considering a refund');
 if(await Payout.verification.exists({collectionExecutionId:collection._id,
  consumedAt:null,expiresAt:{$gt:new Date()}}).session(session))
  throw fail('An active PIN verification must expire or be resolved before a refund');
 const batch=await treasury.models(conn).batch.findOne({tenantId:tenant._id,branchId:source.branchId,
  sourceType:'money_transfer',sourceRef:'FUNDED:'+String(collection._id)}).session(session).lean();
 if(!batch||batch.reversesBatchId||!batch.journalIds?.length)
  throw fail('The original independently reviewed cash collection is missing from Treasury');
 if(await treasury.models(conn).batch.exists({reversesBatchId:batch._id}).session(session))
  throw fail('The original collection has already been corrected');
 if(source.payoutCurrency){
  const Linked=require('../settlements/models').models(conn);
  const linked=await Linked.settlement.findOne({tenantId:tenant._id,sourceModule:'money_transfer',
   sourceId:source._id}).session(session).lean();
  if(!linked||linked.status!=='collected'||linked.destinationPayoutAccountId||
    linked.providerState!=='unverified'||linked.providerEvidenceId||
    linked.payoutEvidenceId||linked.postingBatchIds?.length!==1||
    String(linked.postingBatchIds[0])!==String(batch._id))
   throw fail('Linked currency evidence is inconsistent or external payout status is uncertain; investigate, do not refund');
 }
 return batch;
}
function assertReadyRefundDrawers(source,collection,accounts){
 const cash=accounts.find(x=>String(x._id)===String(collection.accounts.collectionAccountId));
 const liability=accounts.find(x=>String(x._id)===String(collection.accounts.clearingAccountId));
 if(!cash||!liability||cash.kind!=='cash'||liability.kind!=='transfer_clearing'||
  cash.currency!==source.currency||liability.currency!==source.currency||
  String(cash.branchId)!==String(source.branchId)||String(liability.branchId)!==String(source.branchId)||
  String(cash.operatorId||'')!==String(collection.createdBy)||
  [cash,liability].some(x=>x.status!=='active'||x.reconciliationState!=='matched'||
   x.openingBalanceMinor==null||!x.openingApprovedAt))
  throw fail('Original cashier drawer or transfer payable is unavailable or not independently reconciled');
 const gross=BigInt(String(source.amountMinor))+BigInt(String(source.feeMinor));
 if(BigInt(String(cash.bookBalanceMinor))<gross||
  BigInt(String(liability.bookBalanceMinor))<BigInt(String(source.amountMinor)))
  throw fail('Insufficient actual original-currency cash or outstanding payable to refund this sender');
 return {cash,liability,gross:String(gross)};
}
function requestInput(input={}){
 if(!UUID.test(String(input.idempotencyKey||'')))throw fail('Reload the refund form for a new request reference',400);
 return {idempotencyKey:String(input.idempotencyKey).toLowerCase(),
  reason:string(input.reason,'refund reason',12,400),
  evidenceReference:string(input.evidenceReference,'sender identity evidence reference',8,120),
  senderPhone:string(input.senderPhone,'sender phone',9,16)};
}
function equivalent(row,sourceId,actor,v){return String(row.sourceId)===String(sourceId)&&
 String(row.requestedBy)===String(actor.id)&&row.reason===v.reason&&
 row.evidenceReference===v.evidenceReference&&row.senderPhone===v.senderPhone;}
async function context(conn,tenant,actor,permission){
 assertTenant(conn,tenant);feature();
 if(!actor?.id||!hasPermission(actor,permission)||!hasModuleForUser(tenant,actor,'money_transfer'))
  throw fail('Money Transfer refund access is unavailable',403);
 return true;
}
async function request(conn,tenant,actor,sourceId,input={}){
 await context(conn,tenant,actor,'money_transfer.create');
 const v=requestInput(input),sourceKey=id(sourceId);
 await Promise.all([ensure(conn),core.ensureTenantIndexes(conn),funded.ensureIndexes(conn),
  treasury.ensure(conn),sms.ensureIndexes(conn)]);
 const Refund=model(conn),prior=await Refund.findOne({idempotencyKey:v.idempotencyKey}).lean();
 if(prior){if(!equivalent(prior,sourceKey,actor,v))throw fail('Refund reference reused with different data');
  return {refund:prior,duplicate:true};}
 const session=await conn.startSession();let result;
 try{await session.withTransaction(async()=>{
  const authorization=await auth.fenceAction(conn,session,actor,tenant,'money_transfer','money_transfer.create');
  const source=await core.transferOrderModel(conn).findOneAndUpdate({_id:sourceKey,status:'collected_manual',
   createdBy:authorization.actor.id},{$inc:{revision:1}},{new:true,session}).lean();
  if(!source)throw fail('Only the originating cashier may request refund of an actually collected and unpaid transfer');
  if(String(authorization.actor.branchId||'')!==String(source.branchId)&&
     authorization.actor.role!=='Tenant Owner')
   throw fail('The original cashier no longer belongs to this refund branch',403);
  const collection=await funded.models(conn).execution.findOne({_id:source.manualCollectionExecutionId}).session(session).lean();
  const facts=cashMethod(source,collection);
  if(v.senderPhone!==source.sender.phone)throw fail('Sender identity must match the original collected transfer',403);
  await sourceChecks(conn,session,authorization.tenant,source,collection);
  const account=await treasury.models(conn).account.findOne({_id:facts.cashAccountId,
   tenantId:tenant._id,branchId:source.branchId,kind:'cash',currency:facts.currency,
   operatorId:collection.createdBy,status:'active',reconciliationState:'matched'}).session(session).lean();
  if(!account||String(account.bookBalanceMinor).startsWith('-'))
   throw fail('The actual originating cashier drawer is unavailable or unreconciled');
  const [created]=await Refund.create([{
   tenantId:tenant._id,sourceId:source._id,collectionExecutionId:collection._id,
   branchId:source.branchId,requestedBy:authorization.actor.id,
   cashAccountId:account._id,currency:facts.currency,
   principalMinor:facts.principalMinor,feeMinor:facts.feeMinor,
   idempotencyKey:v.idempotencyKey,reason:v.reason,
   senderPhone:v.senderPhone,evidenceReference:v.evidenceReference,
   evidenceDigest:crypto.createHash('sha256').update(v.evidenceReference+':'+String(source._id)).digest('hex'),
   status:'pending_review',activeKey:'TRANSFER_REFUND:'+String(source._id)
  }],{session});
  await core.auditEventModel(conn).create([{action:'money_transfer.refund.requested',
   actorId:authorization.actor.id,targetId:created._id,
   metadata:{branchId:String(source.branchId),sourceId:String(source._id),
    currency:facts.currency,principalMinor:facts.principalMinor,feeMinor:facts.feeMinor}}],{session});
  result={refund:created.toObject(),duplicate:false};
 });return result;
 }catch(error){if(error.code===11000)throw fail('This transfer has an existing refund request or a conflicting retry');throw error;}
 finally{await session.endSession();}
}
async function review(conn,tenant,actor,refundId,input={},expectedSourceId=null){
 await context(conn,tenant,actor,'money_transfer.review');
 if(!['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(actor.role)||
  !hasPermission(actor,'treasury.review'))throw fail('A separate Treasury-qualified transfer reviewer is required',403);
 const decision=input.decision;
 if(!['approve','reject'].includes(decision))throw fail('Choose approve or reject',400);
 const note=string(input.note,'independent decision reason',12,400);
 const signedReceipt=decision==='approve'?
  string(input.signedReceiptReference,'signed sender cash-refund receipt',8,120):null;
 if(decision==='approve'&&input.cashHandoverConfirmed!=='confirmed')
  throw fail('Require explicit verification of the real customer cash handover before posting a refund',400);
 await Promise.all([ensure(conn),core.ensureTenantIndexes(conn),funded.ensureIndexes(conn),treasury.ensure(conn),sms.ensureIndexes(conn)]);
 const Refund=model(conn),initial=await Refund.findById(id(refundId)).lean();
 if(!initial)throw fail('Refund request not found',404);
 if(expectedSourceId&&String(initial.sourceId)!==id(expectedSourceId))
  throw fail('Refund does not belong to the requested transfer',403);
 const session=await conn.startSession();let result;
 try{await session.withTransaction(async()=>{
  const authorization=await auth.fenceAction(conn,session,actor,tenant,'money_transfer','money_transfer.review');
  if(!hasPermission(authorization.actor,'treasury.review')||
   !['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(authorization.actor.role))
   throw fail('Independent Treasury reviewer permission changed',403);
  if(String(initial.requestedBy)===String(authorization.actor.id))
   throw fail('The cashier requesting the refund cannot approve it',403);
  if(authorization.actor.role!=='Tenant Owner'&&String(authorization.actor.branchId)!==String(initial.branchId))
   throw fail('Refund reviewer must supervise the actual sending branch',403);
  const pending=await Refund.findOneAndUpdate({_id:initial._id,status:'pending_review',
   tenantId:tenant._id,...(expectedSourceId?{sourceId:id(expectedSourceId)}:{}),
   requestedBy:{$ne:authorization.actor.id}},
   {$inc:{revision:1}},{session,new:true}).lean();
  if(!pending)throw fail('Refund already reviewed, changed or outside your tenant');
  if(decision==='reject'){
   const rejected=await Refund.findOneAndUpdate({_id:pending._id,status:'pending_review'},
    {$set:{status:'rejected',reviewedBy:authorization.actor.id,reviewedAt:new Date(),
     reviewNote:note},$unset:{activeKey:''}},{session,new:true}).lean();
   await core.auditEventModel(conn).create([{action:'money_transfer.refund.rejected',
    actorId:authorization.actor.id,targetId:rejected._id,metadata:{sourceId:String(rejected.sourceId),
     branchId:String(rejected.branchId)}}],{session});
   result={refund:rejected,duplicate:false};return;
  }
  const source=await core.transferOrderModel(conn).findOneAndUpdate({
   _id:pending.sourceId,status:'collected_manual',manualCollectionExecutionId:pending.collectionExecutionId,
   branchId:pending.branchId
  },{$inc:{revision:1}},{session,new:true}).lean();
  if(!source)throw fail('Transfer already paid, refunded, changed or cancelled. Stop the cash refund');
  const collection=await funded.models(conn).execution.findOne({_id:pending.collectionExecutionId}).session(session).lean();
  const facts=cashMethod(source,collection);
  if(String(pending.cashAccountId)!==facts.cashAccountId||pending.currency!==facts.currency||
   String(pending.principalMinor)!==facts.principalMinor||String(pending.feeMinor)!==facts.feeMinor)
   throw fail('Refund is no longer identical to the original collected cash and fee');
  await sourceChecks(conn,session,authorization.tenant,source,collection);
  const accounts=await treasury.models(conn).account.find({
   _id:{$in:[collection.accounts.collectionAccountId,collection.accounts.clearingAccountId]},
   tenantId:tenant._id,branchId:source.branchId
  }).session(session).lean();
  assertReadyRefundDrawers(source,collection,accounts);
  // One authoritative reversal of the original collection: physical cash,
  // transfer payable and any fee-income credit move back together.
  const returned=await treasury.reverseMovements(conn,session,authorization,{
   sourceType:'money_transfer',sourceRef:'FUNDED:'+String(collection._id),
   reversalSourceRef:'MT-REFUND:'+String(source._id),
   description:note,evidenceRef:signedReceipt
  });
  if(returned.duplicate)throw fail('The original sender cash was already refunded');
  const updated=await core.transferOrderModel(conn).findOneAndUpdate({
   _id:source._id,status:'collected_manual',manualCollectionExecutionId:collection._id
  },{$set:{status:'refunded_manual',refundedAt:new Date(),manualRefundId:pending._id},
     $inc:{revision:1}},{session,new:true,runValidators:true}).lean();
  if(!updated)throw fail('Transfer state changed while refunding. No cash was posted');
  // The recipient PIN can no longer produce a payout. The outbox message is
  // suppressed in this same transaction, where not yet sent.
  await funded.models(conn).execution.updateOne({_id:collection._id,status:'posted_manual'},
   {$set:{pinHash:null},$unset:{pinEncrypted:''},$inc:{revision:1}},{session});
  await sms.closeAfterRefund(conn,collection._id,session);
  if(source.payoutCurrency){
   const Linked=require('../settlements/models').models(conn),now=new Date();
   const linked=await Linked.settlement.findOneAndUpdate({
    tenantId:tenant._id,sourceModule:'money_transfer',sourceId:source._id,
    status:'collected',destinationPayoutAccountId:null
   },{$set:{status:'reversed',reversedAt:now},$push:{postingBatchIds:returned.batch._id},
       $inc:{revision:1}},{session,new:true}).lean();
   if(!linked)throw fail('Original cross-currency collection no longer supports this cash refund');
   await Linked.event.create([{tenantId:tenant._id,settlementId:linked._id,
    branchId:source.branchId,stage:'reversed',evidenceSource:'signed_receipt',
    evidenceDigest:crypto.createHash('sha256')
     .update('MT-REFUND:'+String(source._id)+':'+signedReceipt).digest('hex'),
    observedAt:now,recordedBy:authorization.actor.id}],{session});
  }
  const posted=await Refund.findOneAndUpdate({_id:pending._id,status:'pending_review'},
   {$set:{status:'posted_refund',reviewedBy:authorization.actor.id,reviewedAt:new Date(),
    reviewNote:note,refundReceiptReference:signedReceipt,reversalBatchId:returned.batch._id,
    journalIds:returned.journalIds},$inc:{revision:1}},{session,new:true}).lean();
  if(!posted)throw fail('Refund request changed during posting');
  await core.auditEventModel(conn).create([{action:'money_transfer.refund.posted',
   actorId:authorization.actor.id,targetId:posted._id,metadata:{
    sourceId:String(source._id),branchId:String(source.branchId),currency:facts.currency,
    principalMinor:facts.principalMinor,feeMinor:facts.feeMinor,
    fundsBatchId:String(returned.batch._id),journalIds:(returned.journalIds||[]).map(String)
   }}],{session});
  result={refund:posted,duplicate:false};
 });return result;
 }finally{await session.endSession();}
}
async function detail(conn,tenant,actor,sourceId){
 assertTenant(conn,tenant);
 if(!hasModuleForUser(tenant,actor,'money_transfer')||!hasPermission(actor,'money_transfer.view'))
  throw fail('Transfer view permission required',403);
 const source=await core.transferOrderModel(conn).findOne({_id:id(sourceId)}).lean();
 if(!source)throw fail('Transfer not found',404);
 if(!['Tenant Owner','Auditor'].includes(actor.role)&&
  String(source.branchId)!==String(actor.branchId))
  throw fail('Refund data outside your authorized sending branch',403);
 const rows=await model(conn).find({tenantId:tenant._id,sourceId:source._id})
  .sort({createdAt:-1,_id:-1}).limit(10).lean();
 return rows.map(row=>({
  id:String(row._id),status:row.status,reason:row.reason,requestedBy:String(row.requestedBy),
  requestedAt:row.createdAt,reviewedAt:row.reviewedAt,reviewNote:row.reviewNote,
  signedReceiptReference:row.status==='posted_refund'?row.refundReceiptReference:null,
  compensationBatch:row.status==='posted_refund'?String(row.reversalBatchId||''):null,
  currency:row.currency,amount:formatMoneyMinor(
   String(BigInt(String(row.principalMinor))+BigInt(String(row.feeMinor))),row.currency)
 }));
}
module.exports={fail,cashMethod,assertReadyRefundDrawers,requestInput,request,review,detail,sourceChecks};
