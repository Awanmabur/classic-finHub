'use strict';
// Actual same-currency, different-branch cash reimbursement of a posted transfer.
// Never convert SSP into USD, invent a receiving drawer balance or silently
// "settle" cross-currency obligations. Both custody legs and their original
// interbranch receivable/payable are posted atomically.
const core=require('../models');
const funded=require('../funded/models');
const treasury=require('../treasury/service');
const auth=require('../services/financialAuthorization.service');
const {model,ensure}=require('./interbranchCash.models');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const {hasPermission,hasModuleForUser}=require('../services/moduleAccess.service');
const {formatMoneyMinor}=require('../services/mobileMoney.service');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OID=/^[0-9a-f]{24}$/i;
function fail(message,status=409){return Object.assign(new Error(message),{status});}
function id(value){if(!OID.test(String(value||'')))throw fail('Invalid interbranch reference',400);return String(value);}
function text(value,label,min,max){
 if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||
  /[<>\u0000-\u001f\u007f]/.test(value))
  throw fail('Invalid '+label,400);
 return value.trim();
}
function receipt(value,label){
 const v=text(value,label,8,120).toUpperCase();
 if(!/^[A-Z0-9][A-Z0-9._:/-]{7,119}$/.test(v))
  throw fail('Signed cash receipt reference must use letters, digits, dot, slash, dash, colon or underscore',400);
 return v;
}
function feature(){
 if(process.env.CLASSICFIN_INTERBRANCH_CASH_SETTLEMENT!=='enabled')
  throw fail('Actual interbranch cash reimbursement is not enabled on this deployment',403);
 // The physical handover can precede final journal posting. Until a
 // transaction-safe source drawer reservation and verified return path exist,
 // never expose spendable-in-transit cash to live customer operations, even
 // when a deployment operator accidentally enables the feature flag.
 if(process.env.NODE_ENV==='production')
  throw fail('Production interbranch cash reimbursement is blocked until cash-in-transit reservations and return recovery are implemented',403);
}
function context(conn,tenant,actor){
 if(!tenant?._id||!tenant?.slug||tenant.dbName!==conn?.name||
  conn.name!==tenantDbNameFromSlug(tenant.slug))
  throw fail('Interbranch cash settlement belongs to another tenant database',403);
 if(!actor?.id||!hasModuleForUser(tenant,actor,'money_transfer')||
    !hasPermission(actor,'money_transfer.view')||!hasPermission(actor,'treasury.view'))
  throw fail('Authorized Money Transfer and Treasury access is required',403);
}
function sourcePair(source,collection,payout){
 if(!source||source.status!=='paid_out_manual'||!source.manualPayoutExecutionId||
  !source.manualCollectionExecutionId)
  throw fail('Only a genuinely collected and paid interbranch transfer may be reimbursed');
 if(source.payoutCurrency&&source.payoutCurrency!==source.currency)
  throw fail('SSP and USD obligations cannot be netted. Complete independently verified FX funding first');
 if(!source.branchId||!source.destinationBranchId||
  String(source.branchId)===String(source.destinationBranchId))
  throw fail('This transfer did not use two different physical branches');
 if(!collection||collection.status!=='posted_manual'||collection.action!=='transfer_collect'||
  collection.sourceType!=='money_transfer'||String(collection.sourceId)!==String(source._id)||
  String(collection._id)!==String(source.manualCollectionExecutionId)||
  String(collection.branchId)!==String(source.branchId)||
  !collection.accounts?.collectionAccountId)
  throw fail('Original sender cash collection is missing or inconsistent');
 if(!payout||payout.status!=='posted_manual'||payout.action!=='transfer_payout'||
  payout.sourceType!=='money_transfer'||String(payout.sourceId)!==String(source._id)||
  String(payout._id)!==String(source.manualPayoutExecutionId)||
  String(payout.branchId)!==String(source.destinationBranchId)||
  String(payout.collectionExecutionId)!==String(collection._id)||
  !payout.accounts?.payoutAccountId)
  throw fail('Actual original receiving cashier payout cannot be verified');
 if(!/^[1-9]\d{0,17}$/.test(String(source.amountMinor)))
  throw fail('The exact original transfer principal is invalid');
 return {currency:source.currency,amountMinor:String(source.amountMinor),
  sourceCashAccountId:String(collection.accounts.collectionAccountId),
  destinationCashAccountId:String(payout.accounts.payoutAccountId),
  branchId:String(source.branchId),destinationBranchId:String(source.destinationBranchId),
  collectionActorId:String(collection.createdBy),payoutActorId:String(payout.createdBy)};
}
async function authoritativePair(conn,session,source){
 const [collection,payout]=await Promise.all([
  funded.models(conn).execution.findById(source.manualCollectionExecutionId).session(session).lean(),
  funded.models(conn).execution.findById(source.manualPayoutExecutionId).session(session).lean()
 ]);
 const expected=require('../services/fundedOperations.service');
 if(!collection?.journalIds?.length||!payout?.journalIds?.length||
  !expected.sourceMatches(collection,source)||!expected.sourceMatches(payout,source))
  throw fail('The original reviewed collection/payout journals or immutable economic fingerprints disagree');
 return sourcePair(source,collection,payout);
}
function readyAccounts(pair,accounts){
 const source=accounts.find(a=>String(a._id)===pair.sourceCashAccountId);
 const destination=accounts.find(a=>String(a._id)===pair.destinationCashAccountId);
 if(!source||!destination||String(source._id)===String(destination._id)||
  source.kind!=='cash'||destination.kind!=='cash'||
  source.currency!==pair.currency||destination.currency!==pair.currency||
  String(source.branchId)!==pair.branchId||String(destination.branchId)!==pair.destinationBranchId||
  String(source.operatorId||'')!==pair.collectionActorId||
  String(destination.operatorId||'')!==pair.payoutActorId||
  [source,destination].some(x=>x.status!=='active'||x.openingBalanceMinor==null||
   !x.openingApprovedAt||x.reconciliationState!=='matched'))
  throw fail('Both original cashiers must have their actual, reconciled native-currency drawers');
 if(BigInt(String(source.bookBalanceMinor))<BigInt(pair.amountMinor))
  throw fail('Sending branch has insufficient actual cash for full reimbursement');
 return {source,destination};
}
// Reservation is a spendable-cash hold, not a ledger movement. Treasury
// continues to report the original book balance; every cash debit checks the
// hold, and cash shift closing/opening are blocked while notes are in transit.
async function changeReserve(conn,session,tenant,pair,mode){
 if(!session?.inTransaction())throw fail('Physical cash reservation requires a database transaction');
 if(!['hold','release'].includes(mode))throw fail('Invalid cash reservation operation');
 const Account=treasury.models(conn).account;
 const original=await Account.findOneAndUpdate({
  _id:pair.sourceCashAccountId,tenantId:tenant._id,
  branchId:pair.branchId,currency:pair.currency,kind:'cash',
  operatorId:pair.collectionActorId
 },{$inc:{revision:1}},{session,new:true}).lean();
 if(!original||original.status!=='active'||original.reconciliationState!=='matched'||
  !original.openingApprovedAt||original.openingBalanceMinor==null)
  throw fail('Actual sending drawer is held, unverified or not assigned to original cashier');
 const book=BigInt(String(original.bookBalanceMinor));
 const reserved=BigInt(String(original.reservedCashMinor??'0'));
 const amount=BigInt(pair.amountMinor);
 if(book<0n||reserved<0n||reserved>book||amount<=0n)
  throw fail('Existing Treasury reserved cash or book balance is inconsistent');
 if(mode==='hold'){
  if(book-reserved<amount)
   throw fail('Source cashier cannot hand over more physical cash than their unreserved balance');
  await require('../services/cashDrawer.service').bindFundAccount(
   conn,session,original,String(book));
 }else if(reserved<amount)
  throw fail('The original physical cash custody reservation is missing or already released');
 const next=mode==='hold'?reserved+amount:reserved-amount;
 const updated=await Account.findOneAndUpdate({
  _id:original._id,revision:original.revision
 },{$set:{reservedCashMinor:require('mongoose').Types.Decimal128.fromString(String(next))},
  $inc:{revision:1}},{session,new:true}).lean();
 if(!updated)throw fail('Original cash reservation was modified concurrently');
 return updated;
}
function requestInput(input={}){
 if(!UUID.test(String(input.idempotencyKey||'')))throw fail('Reload the form for a fresh reimbursement reference',400);
 return {
  idempotencyKey:String(input.idempotencyKey).toLowerCase(),
  evidenceReference:receipt(input.evidenceReference,'sending cashier cash-handover evidence'),
  note:text(input.note,'interbranch reimbursement explanation',12,400)
 };
}
async function writeAudit(conn,session,actor,row,action){
 await core.auditEventModel(conn).create([{
  action:'interbranch_cash.'+action,actorId:actor.id,targetId:row._id,
  metadata:{transferId:String(row.transferId),branchId:String(row.branchId),
   destinationBranchId:String(row.destinationBranchId),currency:row.currency,
   amountMinor:String(row.amountMinor)}
 }],{session});
}
async function request(conn,tenant,actor,transferId,input={}){
 context(conn,tenant,actor);feature();
 const sourceId=id(transferId),value=requestInput(input);
 await Promise.all([core.ensureTenantIndexes(conn),treasury.ensure(conn),
  funded.ensureIndexes(conn),ensure(conn)]);
 const Model=model(conn);
 const session=await conn.startSession();
 try{return await session.withTransaction(async()=>{
  const authorization=await auth.fenceAction(conn,session,actor,tenant,'money_transfer','money_transfer.view');
  if(!hasPermission(authorization.actor,'treasury.observe'))throw fail('Cash custody authority required',403);
  const prior=await Model.findOne({tenantId:authorization.tenant._id,
   idempotencyKey:value.idempotencyKey}).session(session).lean();
  if(prior){
   if(String(prior.transferId)!==sourceId||
    String(prior.requestedBy)!==String(authorization.actor.id)||
    String(prior.branchId)!==String(authorization.actor.branchId||'')||
    authorization.actor.role!=='Money Transfer Operator'||
    prior.evidenceReference!==value.evidenceReference||prior.note!==value.note)
    throw fail('Reimbursement reference reused or the original cashier lost access',403);
   return {reimbursement:prior,duplicate:true};
  }
  const source=await core.transferOrderModel(conn).findOneAndUpdate({
   _id:sourceId,status:'paid_out_manual'
  },{$inc:{revision:1}},{session,new:true}).lean();
  if(!source)throw fail('The original transfer has not been paid out');
  const pair=await authoritativePair(conn,session,source);
  if(authorization.actor.role!=='Money Transfer Operator'||
   String(authorization.actor.branchId)!==pair.branchId||
   String(authorization.actor.id)!==pair.collectionActorId)
   throw fail('Only the original sending cashier may request reimbursement; a different tenant owner must independently review it',403);
  const existing=await Model.findOne({tenantId:tenant._id,transferId:source._id,
   activeKey:{$type:'string'}}).session(session).lean();
  if(existing)throw fail('A reimbursement is already pending or posted for this transfer');
  await changeReserve(conn,session,authorization.tenant,pair,'hold');
  const [created]=await Model.create([{
   tenantId:tenant._id,transferId:source._id,branchId:pair.branchId,
   destinationBranchId:pair.destinationBranchId,
   sourceCashAccountId:pair.sourceCashAccountId,
   destinationCashAccountId:pair.destinationCashAccountId,
   currency:pair.currency,amountMinor:pair.amountMinor,
   requestedBy:authorization.actor.id,idempotencyKey:value.idempotencyKey,
   evidenceReference:value.evidenceReference,note:value.note,
   activeKey:'IB-CASH:'+String(source._id),reservedAt:new Date()
  }],{session});
  await writeAudit(conn,session,authorization.actor,created,'requested');
  return {reimbursement:created.toObject(),duplicate:false};
 });}catch(error){if(error.code===11000)throw fail('This transfer has an existing cash reimbursement or conflicting retry');throw error;}
 finally{await session.endSession();}
}
async function confirmReceipt(conn,tenant,actor,reimbursementId,input={},expectedTransferId=null){
 context(conn,tenant,actor);feature();
 const evidenceReference=receipt(input.receiverReceiptReference,'actual receiving cashier signed receipt');
 const note=text(input.receiverNote,'receiving cashier counted-cash note',12,400);
 if(input.cashCountConfirmed!=='confirmed')
  throw fail('The actual receiving cashier must confirm the counted banknotes received',400);
 await Promise.all([core.ensureTenantIndexes(conn),funded.ensureIndexes(conn),ensure(conn)]);
 const Model=model(conn),initial=await Model.findById(id(reimbursementId)).lean();
 if(!initial)throw fail('Interbranch cash handover not found',404);
 if(expectedTransferId&&String(initial.transferId)!==id(expectedTransferId))
  throw fail('Interbranch receipt is for a different transfer',403);
 if(evidenceReference===initial.evidenceReference)
  throw fail('The receiving branch must provide separate original receipt evidence');
 const session=await conn.startSession();
 try{return await session.withTransaction(async()=>{
  const authorization=await auth.fenceAction(conn,session,actor,tenant,'money_transfer','money_transfer.payout');
  if(authorization.actor.role!=='Money Transfer Operator'||
   String(authorization.actor.branchId)!==String(initial.destinationBranchId))
   throw fail('The independently recorded receiving teller must confirm their own actual branch cash',403);
  const source=await core.transferOrderModel(conn).findOneAndUpdate({
   _id:initial.transferId,status:'paid_out_manual',branchId:initial.branchId,
   destinationBranchId:initial.destinationBranchId
  },{$inc:{revision:1}},{session,new:true}).lean();
  if(!source)throw fail('Original transfer changed before receiving cashier acceptance');
  const pair=await authoritativePair(conn,session,source);
  if(pair.payoutActorId!==String(authorization.actor.id)||
   pair.destinationCashAccountId!==String(initial.destinationCashAccountId)||
   pair.currency!==initial.currency||pair.amountMinor!==String(initial.amountMinor))
   throw fail('Only the original paid-out cashier may confirm the exact original cash receipt',403);
  const changed=await Model.findOneAndUpdate({
   _id:initial._id,tenantId:tenant._id,status:'pending_receiver',
   receiverReceiptReference:null,
   ...(expectedTransferId?{transferId:id(expectedTransferId)}:{})
  },{$set:{status:'pending_review',receivedBy:authorization.actor.id,
   receiverConfirmedAt:new Date(),receiverReceiptReference:evidenceReference,
   receiverNote:note},$inc:{revision:1}},{session,new:true}).lean();
  if(!changed)throw fail('Receiving cash was already confirmed, rejected or changed');
  await writeAudit(conn,session,authorization.actor,changed,'receiver_confirmed');
  return {reimbursement:changed,duplicate:false};
 });}catch(error){if(error.code===11000)
  throw fail('This receiving-branch receipt was already used for another cash reimbursement');throw error;
 }finally{await session.endSession();}
}
async function counterBalance(conn,session,account,currency,branchId,normalSide){
 const sums=await core.ledgerPostingModel(conn).aggregate([
  {$match:{accountId:account,currency,branchId}},
  {$group:{_id:'$side',total:{$sum:'$amountMinor'}}}
 ]).session(session);
 let balance=0n;
 for(const r of sums)balance+=BigInt(String(r.total))*(r._id===normalSide?1n:-1n);
 return balance;
}
async function review(conn,tenant,actor,reimbursementId,input={},expectedTransferId=null){
 context(conn,tenant,actor);feature();
 if(!['approve','reject'].includes(input.decision))throw fail('Choose approve or reject',400);
 const note=text(input.note,'independent interbranch review',12,400);
 const confirmed=input.decision==='approve';
 const senderReference=confirmed?
  receipt(input.senderHandoverReference,'signed sending-branch handover'):null;
 const receiverReference=confirmed?
  receipt(input.receiverReceiptReference,'signed receiving-branch receipt'):null;
 if(confirmed&&(senderReference===receiverReference||input.bothBranchesVerified!=='confirmed'))
  throw fail('Independent origin handover and destination receipt must both be verified',400);
 await Promise.all([core.ensureTenantIndexes(conn),treasury.ensure(conn),
  funded.ensureIndexes(conn),ensure(conn)]);
 const Model=model(conn),initial=await Model.findById(id(reimbursementId)).lean();
 if(!initial)throw fail('Cash reimbursement not found',404);
 if(expectedTransferId&&String(initial.transferId)!==id(expectedTransferId))
  throw fail('Cash reimbursement belongs to another transfer',403);
 const session=await conn.startSession();
 try{return await session.withTransaction(async()=>{
  const authorization=await auth.fenceAction(conn,session,actor,tenant,'money_transfer','money_transfer.review');
  if(authorization.actor.role!=='Tenant Owner'||
   !hasPermission(authorization.actor,'treasury.review')||
   String(authorization.actor.id)===String(initial.requestedBy))
   throw fail('A different tenant owner must independently verify both physical branches',403);
  const locked=await Model.findOneAndUpdate({_id:initial._id,tenantId:tenant._id,
   status:confirmed?'pending_review':{$in:['pending_receiver','pending_review']},
   ...(confirmed?{receiverConfirmedAt:{$ne:null},
    receiverReceiptReference:{$type:'string'}}:{}),
   requestedBy:{$ne:authorization.actor.id},
   ...(expectedTransferId?{transferId:id(expectedTransferId)}:{})},
   {$inc:{revision:1}},{new:true,session}).lean();
  if(!locked)throw fail('Reimbursement already decided or outside your tenant');
  if(String(locked.receivedBy||'')===String(locked.requestedBy)||
   String(locked.receivedBy||'')===String(authorization.actor.id))
   throw fail('Sender, receiver and financial reviewer must be different authenticated people',403);
  if(!confirmed){
   const rejected=await Model.findOneAndUpdate({_id:locked._id,status:locked.status},
    {$set:{status:'return_pending',reviewedBy:authorization.actor.id,reviewedAt:new Date(),
     reviewNote:note}},{new:true,session}).lean();
   await writeAudit(conn,session,authorization.actor,rejected,'rejected');
   return {reimbursement:rejected,duplicate:false};
  }
  if(senderReference!==locked.evidenceReference||
   receiverReference!==locked.receiverReceiptReference)
   throw fail('Independent review must use the same signed sender and receiver evidence previously recorded');
  const source=await core.transferOrderModel(conn).findOneAndUpdate({
   _id:locked.transferId,status:'paid_out_manual',
   branchId:locked.branchId,destinationBranchId:locked.destinationBranchId
  },{$inc:{revision:1}},{new:true,session}).lean();
  if(!source)throw fail('Transfer changed during physical cash reimbursement');
  const pair=await authoritativePair(conn,session,source);
  if(pair.currency!==locked.currency||pair.amountMinor!==String(locked.amountMinor)||
   pair.sourceCashAccountId!==String(locked.sourceCashAccountId)||
   pair.destinationCashAccountId!==String(locked.destinationCashAccountId))
   throw fail('Actual original cash, payout and reimbursement values disagree');
  const accounts=await treasury.models(conn).account.find({
   _id:{$in:[locked.sourceCashAccountId,locked.destinationCashAccountId]},
   tenantId:tenant._id
  }).session(session).lean();
  readyAccounts(pair,accounts);
  // The physical handover hold is consumed in the same transaction as the
  // actual origin debit; an unrelated cash-out can never use the held notes.
  if(!locked.reservedAt)throw fail('Actual sender cash was not reserved at handover');
  await changeReserve(conn,session,authorization.tenant,pair,'release');
  const Counter=treasury.models(conn).counter;
  const [payable,receivable]=await Promise.all([
   Counter.findOne({tenantId:tenant._id,branchId:pair.branchId,
    currency:pair.currency,purpose:'interbranch_payable'}).session(session).lean(),
   Counter.findOne({tenantId:tenant._id,branchId:pair.destinationBranchId,
    currency:pair.currency,purpose:'interbranch_receivable'}).session(session).lean()
  ]);
  if(!payable||!receivable)throw fail('Unsettled branch receivable/payable ledger accounts do not exist');
  const [owed,receivableBalance]=await Promise.all([
   counterBalance(conn,session,payable.ledgerAccountId,pair.currency,source.branchId,'credit'),
   counterBalance(conn,session,receivable.ledgerAccountId,pair.currency,source.destinationBranchId,'debit')
  ]);
  if(owed<BigInt(pair.amountMinor)||receivableBalance<BigInt(pair.amountMinor))
   throw fail('Interbranch payable or receivable was already settled or is inconsistent');
  const origin=await treasury.applyMovements(conn,session,authorization,{
   sourceType:'treasury_funding',sourceRef:'IB-CASH:'+String(locked._id)+':ORIGIN',
   branchId:pair.branchId,operatingActorId:pair.collectionActorId,
   legs:[{accountId:pair.sourceCashAccountId,deltaMinor:'-'+pair.amountMinor}],
   ledgerLines:[{currency:pair.currency,accountId:String(payable.ledgerAccountId),
    side:'debit',amountMinor:pair.amountMinor}],
   description:'Verified physical cash reimbursement to destination branch',
   evidenceReference:senderReference
  });
  const destination=await treasury.applyMovements(conn,session,authorization,{
   sourceType:'treasury_funding',sourceRef:'IB-CASH:'+String(locked._id)+':DEST',
   branchId:pair.destinationBranchId,operatingActorId:pair.payoutActorId,
   legs:[{accountId:pair.destinationCashAccountId,deltaMinor:pair.amountMinor}],
   ledgerLines:[{currency:pair.currency,accountId:String(receivable.ledgerAccountId),
    side:'credit',amountMinor:pair.amountMinor}],
   description:'Verified receipt of original sender branch reimbursement',
   evidenceReference:receiverReference
  });
  if(origin.duplicate||destination.duplicate)throw fail('One of the branch cash custody entries was already posted');
  const posted=await Model.findOneAndUpdate({_id:locked._id,status:'pending_review'},
   {$set:{status:'posted',reviewedBy:authorization.actor.id,reviewedAt:new Date(),
    reviewNote:note,senderHandoverReference:senderReference,
    receiverReceiptReference:receiverReference,
    originBatchId:origin.batch._id,destinationBatchId:destination.batch._id}},
   {new:true,session}).lean();
  if(!posted)throw fail('Cash settlement changed concurrently');
  await writeAudit(conn,session,authorization.actor,posted,'posted');
  return {reimbursement:posted,duplicate:false};
 });}finally{await session.endSession();}
}
async function detail(conn,tenant,actor,transferId){
 context(conn,tenant,actor);
 const source=await core.transferOrderModel(conn).findById(id(transferId)).lean();
 if(!source)throw fail('Original Money Transfer not found',404);
 if(!['Tenant Owner','Auditor'].includes(actor.role)&&
  ![source.branchId,source.destinationBranchId].some(v=>String(v)===String(actor.branchId)))
  throw fail('Original Money Transfer belongs to another branch',403);
 const rows=await model(conn).find({tenantId:tenant._id,transferId:source._id})
  .sort({createdAt:-1,_id:-1}).limit(10).lean();
 return rows.map(x=>({
  id:String(x._id),status:x.status,
  origin:String(x.branchId),destination:String(x.destinationBranchId),
  currency:x.currency,amount:formatMoneyMinor(x.amountMinor,x.currency),
  requestedBy:String(x.requestedBy),
  receivedBy:x.receivedBy?String(x.receivedBy):null,
  receiverConfirmedAt:x.receiverConfirmedAt||null,
  reviewedBy:x.reviewedBy?String(x.reviewedBy):null,
  note:x.note,senderOriginalEvidence:x.evidenceReference,
  receiverNote:x.receiverNote||null,reviewNote:x.reviewNote||null,
  senderHandoverReference:x.senderHandoverReference||null,
  receiverReceiptReference:x.receiverReceiptReference||null,
  originBatchId:x.originBatchId?String(x.originBatchId):null,
  destinationBatchId:x.destinationBatchId?String(x.destinationBatchId):null
 }));
}
module.exports={sourcePair,readyAccounts,changeReserve,requestInput,receipt,request,confirmReceipt,review,detail,feature,fail};
