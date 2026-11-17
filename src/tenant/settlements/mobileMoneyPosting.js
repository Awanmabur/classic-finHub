'use strict';
// Atomic native-currency wallet + physical cash movement for an internally
// recorded cross-currency Mobile Money customer operation.
//
// Called ONLY by the existing authorized Mobile Money recording transaction.
// This does not establish external provider confirmation or settlement.
// It reuses one real cashier-owned cash account across all modules.
const crypto=require('node:crypto');
const treasury=require('../treasury/service');
const preview=require('./preview');
const {models:linkedModels}=require('./models');
const planner=require('./planner');
function fingerprint(values,plan){
 return crypto.createHash('sha256').update(JSON.stringify({
  source:'mobile_money',idempotencyKey:values.idempotencyKey,networkReference:values.networkReference,
  branchId:plan.branchId,operation:plan.operation,rateId:plan.rateSnapshot.rateId,
  walletAccountId:plan.custodyLegs[0].accountId,cashAccountId:plan.custodyLegs[1].accountId,
  providerCurrency:plan.providerCurrency,cashCurrency:plan.cashCurrency,
  providerPrincipalMinor:plan.providerPrincipalMinor,actualCashMinor:plan.actualCashMinor
 })).digest('hex');
}
function assertRecording(values,operatorConfirmation){
 if(values.paymentMethod!=='Cash')throw planner.fail('Cross-currency Mobile Money must use physical cash',400);
 if(operatorConfirmation!==true)throw planner.fail('Confirm the actual foreign-currency cash handover before recording',400);
 // Keep principal movement separate from provider commissions and customer fees.
 // Accepted tariff snapshots remain informational, never automatic income.
 if(BigInt(String(values.feeMinor||0))!==0n||values.feeTreatment!=='record_only')
  throw planner.fail('Cross-currency customer principal cannot contain estimated or collected fees; use separate verified fee records',409);
}
async function apply(conn,session,authorization,branch,values,{cashHandoverConfirmed=false}={}){
 if(!session?.inTransaction())throw planner.fail('Linked currency funds must post in one database transaction',409);
 assertRecording(values,cashHandoverConfirmed);
 const actor={...authorization.actor,transactionBranchId:String(branch._id)};
 const result=await preview.mobileMoney(conn,authorization.tenant,actor,branch,{
  operation:values.operation,providerPrincipalMinor:String(values.amountMinor),
  walletAccountId:values.walletAccountId,cashAccountId:values.paymentAccountId,
  cashCurrency:values.cashCurrency,rateId:values.fxRateId
 },session);
 const plan=result.quote;
 // Revalidate the selected provider wallet and configured fee policy inside the
 // transaction, not from an earlier GET/quote. No implicit network swap.
 const wallet=await preview.wallet(conn,authorization.tenant,actor,branch,plan.custodyLegs[0].accountId,session);
 if(wallet.network!==values.network||wallet.currency!==values.currency||wallet.feeTreatment!=='record_only')
  throw planner.fail('Wallet provider or fee policy changed; review actual account settings',409);
 const cash=await preview.ownDrawer(conn,authorization.tenant,actor,branch,plan.cashCurrency,plan.custodyLegs[1].accountId,session);
 if(String(wallet._id)===String(cash._id))throw planner.fail('Wallet and physical drawer must be different',409);
 const counterLines=[];
 for(const leg of plan.custodyLegs){
  const counter=await treasury.ensureCounterAccount(conn,session,{
   tenantId:authorization.tenant._id,branchId:branch._id,currency:leg.currency,
   purpose:'settlement_clearing',actorId:authorization.actor.id
  });
  const delta=BigInt(leg.deltaMinor);
  counterLines.push({currency:leg.currency,accountId:counter.ledgerAccountId,
   side:delta>0n?'credit':'debit',amountMinor:String(delta<0n?-delta:delta)});
 }
 const funds=await treasury.applyMovements(conn,session,authorization,{
  sourceType:'mobile_money',sourceRef:'MM:'+values.idempotencyKey,
  branchId:String(branch._id),legs:plan.custodyLegs.map(leg=>({
   accountId:leg.accountId,deltaMinor:leg.deltaMinor
  })),
  ledgerLines:counterLines,
  description:`${values.network} linked currency ${values.operation} ${values.networkReference}`,
  evidenceReference:values.networkReference
 });
 const after=funds.movements.find(row=>String(row.accountId)===String(wallet._id));
 if(!after)throw planner.fail('Wallet movement is missing from the atomic treasury batch',503);
 const walletDelta=BigInt(plan.custodyLegs[0].deltaMinor);
 const afterBalance=BigInt(String(after.balanceAfterMinor));
 return {
  quote:plan,batch:funds.batch,
  funding:{
   walletAccountId:wallet._id,paymentAccountId:cash._id,
   fundingState:'book_recorded',feeTreatment:'record_only',
   fundsSourceRef:'MM:'+values.idempotencyKey,fundJournalIds:funds.journalIds,
   walletBalanceBeforeMinor:String(afterBalance-walletDelta),
   walletBalanceAfterMinor:String(afterBalance),
   physicalCashMovementMinor:plan.custodyLegs[1].deltaMinor,
   cashCurrency:plan.cashCurrency,fxRateId:plan.rateSnapshot.rateId,
   fxRateSide:plan.rateSnapshot.side,fxRateDecimal:plan.rateSnapshot.rateDecimal,
   fxCashMinor:plan.actualCashMinor
  },
  evidenceDigest:fingerprint(values,plan)
 };
}
async function link(conn,session,authorization,actor,created,linkedId,posted){
 if(!session?.inTransaction()||!created?._id||!posted?.batch||!posted.quote||
    String(created.linkedSettlementId)!==String(linkedId))
  throw planner.fail('Cross-currency settlement must be linked to its original posted transaction',409);
 const plan=posted.quote,Rate=plan.rateSnapshot,Model=linkedModels(conn);
 const [saved]=await Model.settlement.create([{
  _id:linkedId,tenantId:authorization.tenant._id,branchId:plan.branchId,
  sourceModule:'mobile_money',sourceId:created._id,sourceReference:created.networkReference,
  idempotencyKey:created.idempotencyKey,sourceFingerprint:posted.evidenceDigest,
  operation:plan.operation,providerCurrency:plan.providerCurrency,cashCurrency:plan.cashCurrency,
  providerPrincipalMinor:plan.providerPrincipalMinor,physicalCashMinor:plan.actualCashMinor,
  rateSnapshot:{rateId:Rate.rateId,side:Rate.side,fromCurrency:Rate.fromCurrency,
   toCurrency:Rate.toCurrency,rateDecimal:Rate.rateDecimal,approvedBy:Rate.approvedBy,
   expiresAt:Rate.expiresAt},
  walletAccountId:plan.custodyLegs[0].accountId,cashAccountId:plan.custodyLegs[1].accountId,
  postingBatchIds:[posted.batch._id],status:'posted',providerState:'unverified',
  occurredAt:created.createdAt,postedAt:created.createdAt,createdBy:actor.id
 }],{session});
 await Model.event.create([{
  tenantId:authorization.tenant._id,settlementId:linkedId,branchId:plan.branchId,
  stage:plan.operation==='cash_out'?'cash_paid':'cash_collected',
  evidenceSource:'internal_journal',evidenceDigest:posted.evidenceDigest,
  observedAt:created.createdAt,recordedBy:actor.id
 }],{session});
 return saved;
}
module.exports={fingerprint,assertRecording,apply,link};
