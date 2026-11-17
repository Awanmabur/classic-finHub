'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const settlement=require('../src/tenant/services/mobileMoneySettlement.service');

const rateId='507f1f77bcf86cd799439001';
const branchId='507f1f77bcf86cd799439002';
const base={operation:'cash_out',currency:'UGX',settlementCurrency:'SSP',amountMinor:'100000',
 feeTreatment:'record_only',paymentMethod:'Cash',forexRateId:rateId,settlementAmountMinor:'9000000',crossCurrency:true};
const rate={_id:rateId,branchId,status:'active',side:'buy',fromCurrency:'UGX',toCurrency:'SSP',
 rateDecimal:'0.90',expiresAt:new Date('2030-01-01T00:00:00Z')};

test('Mobile Money cash-in and cash-out use the economic direction of the provider float',()=>{
 assert.equal(settlement.direction('cash_out'),'buy');
 assert.equal(settlement.direction('cash_in'),'sell');
 assert.throws(()=>settlement.direction('quote'),{status:400});
});

test('Normal same-currency deposits require no rate or extra cash amount',()=>{
 assert.deepEqual(settlement.normalize({},'UGX'),{settlementCurrency:'UGX',
  forexRateId:null,settlementAmountMinor:null,crossCurrency:false});
 assert.throws(()=>settlement.normalize({settlementCurrency:'UGX',settlementAmount:'4'},'UGX'),{status:400});
});

test('Real SSP settlement is explicit and cannot silently be booked in UGX',()=>{
 const input=settlement.normalize({settlementCurrency:'SSP',forexRateId:rateId,settlementAmount:'90000.00'},'UGX');
 assert.deepEqual(input,{settlementCurrency:'SSP',forexRateId:rateId,settlementAmountMinor:9000000,crossCurrency:true});
 assert.deepEqual(settlement.pricingSnapshot({...base,...input},rate,branchId,{
  toISOString:()=>new Date('2026-11-17').toISOString()
 }),{settlementCurrency:'SSP',settlementAmountMinor:'9000000',forexRateId:rateId,
  forexRateDecimal:'0.90',forexSide:'buy',crossCurrency:true});
});

test('Wrong rate, cash amount, reversed operation, or unverified fees cannot post',()=>{
 assert.throws(()=>settlement.normalize({settlementCurrency:'SSP',forexRateId:'no',settlementAmount:'90000'},'UGX'),{status:409});
 assert.throws(()=>settlement.normalize({settlementCurrency:'SSP',forexRateId:rateId,settlementAmount:'xx'},'UGX'),{status:400});
 for(const change of [
  {forexRateId:'507f1f77bcf86cd799439010'},
  {settlementAmountMinor:'9000001'},
  {feeTreatment:'payment_collected'},
  {paymentMethod:'Bank'},
  {operation:'cash_in'},
  {settlementCurrency:'USD'}
 ])assert.throws(()=>settlement.pricingSnapshot({...base,...change},rate,branchId),{status:409},'No unapproved FX settlement can be posted');
 assert.throws(()=>settlement.pricingSnapshot(base,{...rate,expiresAt:new Date('2026-01-01')},branchId),{status:409});
});

test('An approved sell rate is required for customer cash-in, never the buy rate',()=>{
 const sell={...rate,side:'sell',rateDecimal:'1.10'};
 const values={...base,operation:'cash_in',settlementAmountMinor:'11000000'};
 assert.equal(settlement.pricingSnapshot(values,sell,branchId).settlementAmountMinor,'11000000');
 assert.throws(()=>settlement.pricingSnapshot(values,rate,branchId),{status:409});
});
