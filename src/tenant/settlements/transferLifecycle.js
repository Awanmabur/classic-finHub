'use strict';
// Bind the existing reviewed collection + PIN payout executions to one
// cross-currency financial fact. These writes use the exact same Mongo session
// as source status, native Treasury postings, outbox and audit events.
const crypto=require('node:crypto');
const {models}=require('./models');
const {fail}=require('./planner');
const digest=(label,...ids)=>crypto.createHash('sha256').update([label,...ids.map(String)].join(':')).digest('hex');
function assertCross(tenant,source,execution,session){
 if(!session?.inTransaction())throw fail('Linked transfer evidence needs the original database transaction');
 if(!tenant?._id||!source?._id||!source.payoutCurrency||!source.payoutMinor||
   !source.fxRateId||!source.fxRateApprovedBy||!source.fxRateDecimal||!source.fxRateExpiresAt)
  throw fail('Cross-currency transfer is missing original approved pricing evidence');
 if(String(execution?.sourceId)!==String(source._id)||execution.sourceType!=='money_transfer')
  throw fail('Linked transfer source and financial execution disagree');
}
function originalTerms(source){
 return {
  tenantId:source.tenantId,branchId:source.branchId,
  sourceModule:'money_transfer',sourceId:source._id,sourceReference:source.reference,
  idempotencyKey:source.idempotencyKey,
  operation:'transfer_cross_currency',
  providerCurrency:source.payoutCurrency,cashCurrency:source.currency,
  providerPrincipalMinor:String(source.payoutMinor),physicalCashMinor:String(source.amountMinor),
  rateSnapshot:{
   rateId:source.fxRateId,side:'sell',fromCurrency:source.payoutCurrency,
   toCurrency:source.currency,rateDecimal:source.fxRateDecimal,
   approvedBy:source.fxRateApprovedBy,expiresAt:source.fxRateExpiresAt
  }
 };
}
async function recordCollection(conn,session,tenant,actor,source,execution,posting){
 assertCross(tenant,source,execution,session);
 if(execution.action!=='transfer_collect'||!posting?.batch?._id||!execution.accounts?.collectionAccountId)
  throw fail('Collection must already be posted to a real cash account');
 const Linked=models(conn),now=new Date();
 const [linked]=await Linked.settlement.create([{
  ...originalTerms(source),tenantId:tenant._id,sourceFingerprint:execution.sourceFingerprint,
  cashAccountId:execution.accounts.collectionAccountId,
  destinationBranchId:source.destinationBranchId||source.branchId,
  postingBatchIds:[posting.batch._id],status:'collected',
  occurredAt:now,createdBy:source.createdBy
 }],{session});
 await Linked.event.create([{
  tenantId:tenant._id,settlementId:linked._id,branchId:source.branchId,
  stage:'cash_collected',evidenceSource:'internal_journal',
  evidenceDigest:digest('CROSS_TRANSFER_COLLECTION',execution._id,posting.batch._id),
  observedAt:now,recordedBy:actor.id
 }],{session});
 return linked;
}
async function recordPayout(conn,session,tenant,actor,source,execution,posting){
 assertCross(tenant,source,execution,session);
 if(execution.action!=='transfer_payout'||!posting?.batch?._id||
  !execution.accounts?.payoutAccountId||!execution.collectionExecutionId)
  throw fail('Payout must already be posted to the real receiving-currency cash drawer');
 const Linked=models(conn),now=new Date();
 const batchIds=[posting.originBatchId,posting.batch._id].filter(Boolean);
 const settled=await Linked.settlement.findOneAndUpdate({
  tenantId:tenant._id,sourceModule:'money_transfer',sourceId:source._id,
  status:'collected',destinationBranchId:source.destinationBranchId||source.branchId,
  'rateSnapshot.rateId':source.fxRateId,cashCurrency:source.currency,
  providerCurrency:source.payoutCurrency
 },{$set:{status:'posted',postedAt:now,
   destinationPayoutAccountId:execution.accounts.payoutAccountId},
   $push:{postingBatchIds:{$each:batchIds}},$inc:{revision:1}},
 {session,new:true}).lean();
 if(!settled)throw fail('Original cross-currency collection is unavailable or already paid',409);
 await Linked.event.create([{
  tenantId:tenant._id,settlementId:settled._id,branchId:execution.branchId,
  stage:'cash_paid',evidenceSource:'internal_journal',
  evidenceDigest:digest('CROSS_TRANSFER_PAYOUT',execution._id,...batchIds),
  observedAt:now,recordedBy:actor.id
 }],{session});
 return settled;
}
module.exports={assertCross,originalTerms,recordCollection,recordPayout};
