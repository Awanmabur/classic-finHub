'use strict';
// Bind the existing reviewed collection + PIN payout executions to one
// cross-currency financial fact. These writes use the exact same Mongo session
// as source status, native Treasury postings, outbox and audit events.
const crypto=require('node:crypto');
const {models}=require('./models');
const {fail,integer}=require('./planner');
const {rateScaled,converted}=require('../services/forex.service');
const digest=(label,...ids)=>crypto.createHash('sha256').update([label,...ids.map(String)].join(':')).digest('hex');
function assertEconomics(source){
 const collection=integer(source?.amountMinor,'sender collection');
 const payout=integer(source?.payoutMinor,'recipient payout');
 if(!source?.payoutCurrency||source.currency===source.payoutCurrency)
  throw fail('Linked transfer needs different collection and payout currencies',409);
 if(!source.fxRateId||!source.fxRateDecimal||!source.fxRateApprovedBy)
  throw fail('Linked transfer does not contain its immutable approved rate',409);
 const expected=converted(payout,source.payoutCurrency,source.currency,
  rateScaled(String(source.fxRateDecimal)));
 if(expected!==collection)
  throw fail('Linked transfer amount no longer matches its independently approved Forex rate',409);
 return {collectionMinor:String(collection),payoutMinor:String(payout),
  collectionCurrency:source.currency,payoutCurrency:source.payoutCurrency};
}
function movementPresent(movements,accountId,deltaMinor){
 return Array.isArray(movements)&&movements.some(m=>String(m.accountId)===String(accountId)&&
  String(m.deltaMinor)===String(deltaMinor));
}
function assertCollectionMovement(source,execution,posting){
 const {collectionMinor}=assertEconomics(source);
 if(!posting?.batch?._id||!movementPresent(posting.movements,
     execution.accounts.collectionAccountId,
     String(BigInt(collectionMinor)+BigInt(String(source.feeMinor||0))))||
   !movementPresent(posting.movements,execution.accounts.clearingAccountId,collectionMinor))
  throw fail('Native-currency transfer cash receipt and payable did not post exactly',409);
 return true;
}
function assertPayoutMovements(source,execution,posting){
 const {collectionMinor,payoutMinor}=assertEconomics(source);
 if(!posting?.originBatchId||!posting?.batch?._id||
    String(posting.originBatchId)===String(posting.batch._id)||
    !movementPresent(posting.originMovements,execution.accounts.clearingAccountId,
       '-'+collectionMinor)||
    !movementPresent(posting.movements,execution.accounts.payoutAccountId,'-'+payoutMinor))
  throw fail('Both native-currency transfer payable release and recipient cash payout must post exactly',409);
 return true;
}
function assertCross(tenant,source,execution,session){
 if(!session?.inTransaction())throw fail('Linked transfer evidence needs the original database transaction');
 if(!tenant?._id||!source?._id||!source.payoutCurrency||!source.payoutMinor||
   !source.fxRateId||!source.fxRateApprovedBy||!source.fxRateDecimal||!source.fxRateExpiresAt)
  throw fail('Cross-currency transfer is missing original approved pricing evidence');
 assertEconomics(source);
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
 if(execution.action!=='transfer_collect'||!execution.accounts?.collectionAccountId)
  throw fail('Collection must use a real independently verified receipt account');
 assertCollectionMovement(source,execution,posting);
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
 if(execution.action!=='transfer_payout'||
  !execution.accounts?.payoutAccountId||!execution.collectionExecutionId)
  throw fail('Payout must use the real native-currency recipient cash drawer');
 assertPayoutMovements(source,execution,posting);
 const Linked=models(conn),now=new Date();
 const batchIds=[posting.originBatchId,posting.batch._id].filter(Boolean);
 const settled=await Linked.settlement.findOneAndUpdate({
  tenantId:tenant._id,sourceModule:'money_transfer',sourceId:source._id,
  status:'collected',destinationBranchId:source.destinationBranchId||source.branchId,
  destinationPayoutAccountId:null, // first verified payout only
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
module.exports={assertCross,assertEconomics,assertCollectionMovement,assertPayoutMovements,originalTerms,recordCollection,recordPayout};
