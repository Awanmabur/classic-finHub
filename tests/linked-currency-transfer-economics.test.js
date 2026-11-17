'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fx=require('../src/tenant/settlements/transferLifecycle');
const {converted,rateScaled}=require('../src/tenant/services/forex.service');
const ids={branch:'507f1f77bcf86cd799439011',sender:'507f1f77bcf86cd799439012',
 collector:'507f1f77bcf86cd799439013',recipient:'507f1f77bcf86cd799439014',
 payout:'507f1f77bcf86cd799439015',collectBatch:'507f1f77bcf86cd799439016',
 originBatch:'507f1f77bcf86cd799439017',payoutBatch:'507f1f77bcf86cd799439018'};
const source={_id:ids.sender,currency:'SSP',payoutCurrency:'USD',
 amountMinor:'1300000',payoutMinor:'10000',feeMinor:'100',
 fxRateId:'507f1f77bcf86cd799439019',fxRateDecimal:'130',
 fxRateApprovedBy:'507f1f77bcf86cd799439020',
 fxRateExpiresAt:new Date('2030-01-01'),
 branchId:ids.branch,destinationBranchId:ids.branch};
const collection={action:'transfer_collect',accounts:{
 collectionAccountId:ids.collector,clearingAccountId:ids.recipient}};
const payout={action:'transfer_payout',accounts:{
 payoutAccountId:ids.payout,clearingAccountId:ids.recipient}};
const collectionPosting={batch:{_id:ids.collectBatch},
 movements:[
 {accountId:ids.collector,deltaMinor:'1300100'},
 {accountId:ids.recipient,deltaMinor:'1300000'}]};
const payoutPosting={originBatchId:ids.originBatch,batch:{_id:ids.payoutBatch},
 originMovements:[{accountId:ids.recipient,deltaMinor:'-1300000'}],
 movements:[{accountId:ids.payout,deltaMinor:'-10000'}]};
test('approved foreign payout rate reproduces the exact SSP collection without floating point',()=>{
 assert.equal(converted(10000n,'USD','SSP',rateScaled('130')),1300000n);
 assert.deepEqual(fx.assertEconomics(source),{
  collectionMinor:'1300000',payoutMinor:'10000',
  collectionCurrency:'SSP',payoutCurrency:'USD'
 });
});
test('a changed or missing approved rate and a same-currency transfer are rejected',()=>{
 for(const change of [{amountMinor:'1300001'}, {fxRateDecimal:'125'},
  {fxRateId:null},{payoutCurrency:'SSP'},{payoutMinor:'9999'}]){
  assert.throws(()=>fx.assertEconomics({...source,...change}),{status:409});
 }
});
test('reviewed collection must post both actual cash + fee and the exact sender-currency payable',()=>{
 assert.equal(fx.assertCollectionMovement(source,collection,collectionPosting),true);
 assert.throws(()=>fx.assertCollectionMovement(source,collection,{
  ...collectionPosting,movements:[{accountId:ids.collector,deltaMinor:'1300000'},
    {accountId:ids.recipient,deltaMinor:'1300000'}]}),{status:409});
 assert.throws(()=>fx.assertCollectionMovement(source,collection,{
  ...collectionPosting,movements:[{accountId:ids.collector,deltaMinor:'1300100'}]}),{status:409});
});
test('reviewed payout requires the original teller payable and independently held recipient currency cash',()=>{
 assert.equal(fx.assertPayoutMovements(source,payout,payoutPosting),true);
 for(const modified of [
  {...payoutPosting,originBatchId:null},
  {...payoutPosting,originBatchId:ids.payoutBatch},
  {...payoutPosting,originMovements:[]},
  {...payoutPosting,movements:[{accountId:ids.payout,deltaMinor:'-1300000'}]},
  {...payoutPosting,movements:[{accountId:ids.collector,deltaMinor:'-10000'}]}
 ])assert.throws(()=>fx.assertPayoutMovements(source,payout,modified),{status:409});
});
test('a KES-paid versus USD-received transfer cannot be silently booked as KES cash at payout',()=>{
 const convertedKes=converted(5000n,'USD','KES',rateScaled('150'));
 assert.equal(convertedKes,750000n);
 const order={...source,currency:'KES',amountMinor:String(convertedKes),
  payoutMinor:'5000',fxRateDecimal:'150'};
 assert.equal(fx.assertEconomics(order).collectionCurrency,'KES');
 assert.throws(()=>fx.assertPayoutMovements(order,payout,{
  ...payoutPosting,movements:[{accountId:ids.payout,deltaMinor:'-750000'}]}),{status:409});
});
