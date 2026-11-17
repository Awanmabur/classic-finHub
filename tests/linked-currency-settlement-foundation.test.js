'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const planner=require('../src/tenant/settlements/planner');
const {settlementSchema,costBookSchema}=require('../src/tenant/settlements/models');
const a='507f1f77bcf86cd799439011',b='507f1f77bcf86cd799439012',c='507f1f77bcf86cd799439013',
 d='507f1f77bcf86cd799439014',e='507f1f77bcf86cd799439015',f='507f1f77bcf86cd799439016';
function rate(side,price,overrides={}){
 return {_id:a,branchId:b,fromCurrency:'UGX',toCurrency:'SSP',
  side,rateDecimal:price,status:'active',proposedBy:c,reviewedBy:d,
  reviewedAt:new Date('2026-11-16'),expiresAt:new Date('2030-01-01'),...overrides};
}
test('withdrawal acquires UGX float and pays actual SSP cash using BUY rate',()=>{
 const plan=planner.quote({channel:'mobile_money',operation:'cash_out',
  branchId:b,providerCurrency:'UGX',cashCurrency:'SSP',
  providerPrincipalMinor:'100000',walletAccountId:e,cashAccountId:f,rate:rate('buy','0.9')});
 assert.equal(plan.actualCashMinor,'9000000'); // SSP has 2 minor decimals
 assert.deepEqual(plan.custodyLegs.map(l=>[l.kind,l.currency,l.deltaMinor]),[
  ['wallet','UGX','100000'],['cash','SSP','-9000000']]);
 assert.equal(plan.rateSnapshot.side,'buy');
 assert.equal(plan.profitStatus,'unmeasured_without_verified_cost_basis');
 assert.equal(plan.providerConfirmationStatus,'unverified');
});
test('deposit sells UGX float for SSP and uses SELL rate without inventing commission',()=>{
 const plan=planner.quote({channel:'mobile_money',operation:'cash_in',
  branchId:b,providerCurrency:'UGX',cashCurrency:'SSP',
  providerPrincipalMinor:'100000',walletAccountId:e,cashAccountId:f,rate:rate('sell','1.1')});
 assert.equal(plan.actualCashMinor,'11000000');
 assert.deepEqual(plan.custodyLegs.map(l=>l.deltaMinor),['-100000','11000000']);
 assert.equal(plan.feeTreatment,'separate_provider_evidence');
});
test('wrong side, currency, branch, self-approved, expired or quote-only rates are rejected',()=>{
 const input={channel:'mobile_money',operation:'cash_out',branchId:b,providerCurrency:'UGX',
  cashCurrency:'SSP',providerPrincipalMinor:'100000',walletAccountId:e,cashAccountId:f};
 for(const invalid of [rate('sell','0.9'),rate('quote','0.9'),
  rate('buy','0.9',{toCurrency:'KES'}),
  rate('buy','0.9',{branchId:c}),
  rate('buy','0.9',{reviewedBy:c}),
  rate('buy','0.9',{reviewedBy:null}),
  rate('buy','0.9',{expiresAt:new Date('2020-01-01')})]){
  assert.throws(()=>planner.quote({...input,rate:invalid}),{status:409});
 }
});
test('normal same-currency MoMo must use the established posting path, not pseudo Forex',()=>{
 assert.throws(()=>planner.quote({channel:'mobile_money',operation:'cash_in',branchId:b,
  providerCurrency:'UGX',cashCurrency:'UGX',providerPrincipalMinor:'100000',
  walletAccountId:e,cashAccountId:f}),/same-currency/);
});
test('transfer has separate collection and payout stages across distinct branches',()=>{
 const plan=planner.transferPlan({originBranchId:b,destinationBranchId:c,
  originCashAccountId:e,destinationPayoutAccountId:f,collectionCurrency:'SSP',
  payoutCurrency:'UGX',payoutMinor:'100000',rate:rate('sell','1.1')});
 assert.equal(plan.collectionStage.deltaMinor,'11000000');
 assert.equal(plan.payoutStage.deltaMinor,'-100000');
 assert.equal(plan.collectionStage.branchId,b);
 assert.equal(plan.payoutStage.branchId,c);
 assert.equal(plan.status,'quote_only_no_funds_posted');
 assert.match(plan.note,/separate verified events/);
});
test('transfer plan cannot cross the wrong branch or skip rate approval',()=>{
 assert.throws(()=>planner.transferPlan({originBranchId:b,destinationBranchId:b,
  originCashAccountId:e,destinationPayoutAccountId:f,collectionCurrency:'SSP',
  payoutCurrency:'UGX',payoutMinor:'100000',rate:rate('sell','1.1')}),/same-branch/);
 assert.throws(()=>planner.transferPlan({originBranchId:b,destinationBranchId:c,
  originCashAccountId:e,destinationPayoutAccountId:f,collectionCurrency:'SSP',
  payoutCurrency:'UGX',payoutMinor:'100000',rate:rate('buy','1.1')}),/approved/);
});
test('weighted average cost realization is exact and conserves the full residual',()=>{
 const first=planner.weightedAverageDisposal({holdingMinor:'300',acquisitionCostFunctionalMinor:'100',
  disposedMinor:'100',proceedsFunctionalMinor:'45'});
 assert.deepEqual(first,{disposedMinor:'100',costConsumedFunctionalMinor:'33',
  remainingHoldingMinor:'200',remainingCostFunctionalMinor:'67',
  grossRealizedResultFunctionalMinor:'12',status:'cost_basis_matched',netProfitNotComputed:true});
 const second=planner.weightedAverageDisposal({holdingMinor:first.remainingHoldingMinor,
  acquisitionCostFunctionalMinor:first.remainingCostFunctionalMinor,
  disposedMinor:'200',proceedsFunctionalMinor:'70'});
 assert.equal(second.costConsumedFunctionalMinor,'67');
 assert.equal(second.remainingHoldingMinor,'0');
 assert.equal(second.remainingCostFunctionalMinor,'0');
 assert.equal(BigInt(first.costConsumedFunctionalMinor)+BigInt(second.costConsumedFunctionalMinor),100n);
});
test('cost basis cannot be inferred from zero holding, negative or excess disposals',()=>{
 assert.throws(()=>planner.weightedAverageDisposal({holdingMinor:'0',acquisitionCostFunctionalMinor:'0',
  disposedMinor:'100',proceedsFunctionalMinor:'0'}));
 assert.throws(()=>planner.weightedAverageDisposal({holdingMinor:'20',acquisitionCostFunctionalMinor:'10',
  disposedMinor:'21',proceedsFunctionalMinor:'10'}));
 assert.throws(()=>planner.weightedAverageDisposal({holdingMinor:'20',acquisitionCostFunctionalMinor:'-1',
  disposedMinor:'10',proceedsFunctionalMinor:'10'}));
});
test('linked settlement and cost books have unique immutable source identifiers',()=>{
 const indexes=settlementSchema.indexes();
 assert.ok(indexes.some(([fields,opts])=>fields.sourceModule===1&&fields.sourceId===1&&opts.unique));
 assert.ok(indexes.some(([fields,opts])=>fields.idempotencyKey===1&&opts.unique));
 assert.ok(costBookSchema.indexes().some(([fields,opts])=>fields.accountId===1&&opts.unique));
 assert.equal(settlementSchema.path('sourceModule').options.immutable,true);
 assert.equal(settlementSchema.path('rateSnapshot').options.immutable,true);
});
