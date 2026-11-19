'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {quote}=require('../src/tenant/services/momoFxQuote.service');
const {currencies}=require('../src/config/currencies');

const rateId='507f1f77bcf86cd799439011';
const base={rateId,rateVersion:1,approved:true,expiresAt:'2999-01-01T00:00:00.000Z'};
const input=(operation,providerCurrency,cashCurrency,rateDecimal,minor)=>({
 ...base,operation,providerCurrency,cashCurrency,rateDecimal,
 rateSide:operation==='deposit_cash_send_provider'?'sell':'buy',
 ...(operation==='deposit_cash_send_provider'?{cashAmountMinor:minor}:{providerAmountMinor:minor})
});

test('SSP cash deposit starts with counted cash and deducts only UGX wallet float',()=>{
 const q=quote(input('deposit_cash_send_provider','UGX','SSP','100','50000000'));
 assert.equal(q.cashAmountMinor,'50000000');
 assert.equal(q.providerAmountMinor,'5000');
 assert.equal(q.cashDeltaMinor,'50000000');
 assert.equal(q.walletDeltaMinor,'-5000');
 assert.equal(q.rateSide,'sell');
});

test('UGX wallet withdrawal keeps existing wallet-first calculation',()=>{
 const q=quote(input('withdraw_provider_receive_cash','UGX','SSP','100','5000'));
 assert.equal(q.providerAmountMinor,'5000');
 assert.equal(q.cashAmountMinor,'50000000');
 assert.equal(q.walletDeltaMinor,'5000');
 assert.equal(q.cashDeltaMinor,'-50000000');
 assert.equal(q.rateSide,'buy');
});

test('all enabled cash and wallet currencies use native minor units on cash-first deposits',()=>{
 // Rates are synthetic test fixtures, not market rates.
 const pairs=[
  ['UGX','SSP','100','12345678'],
  ['UGX','USD','0.0025','1250'],
  ['KES','SSP','10','12345678'],
  ['KES','USD','0.008','1234'],
  ['USD','SSP','4000','50000000'],
  ['USD','UGX','4000','500000'],
  ['SSP','KES','0.5','10050'],
  ['SSP','UGX','0.2','10000']
 ];
 for(const [providerCurrency,cashCurrency,rateDecimal,cashMinor] of pairs){
  assert(Object.hasOwn(currencies,providerCurrency)&&Object.hasOwn(currencies,cashCurrency));
  const q=quote(input('deposit_cash_send_provider',providerCurrency,cashCurrency,rateDecimal,cashMinor));
  assert.equal(q.cashAmountMinor,cashMinor,providerCurrency+'/'+cashCurrency+' must preserve actual received cash');
  assert.equal(q.cashDeltaMinor,cashMinor);
  assert(BigInt(q.providerAmountMinor)>0n,'wallet payout must be positive');
  assert.equal(BigInt(q.walletDeltaMinor),-BigInt(q.providerAmountMinor));
 }
});

test('deposit rounds only wallet payout, never silently changes customer cash',()=>{
 const q=quote(input('deposit_cash_send_provider','UGX','SSP','1.2345','10000'));
 assert.equal(q.cashAmountMinor,'10000');
 assert.equal(q.cashDeltaMinor,'10000');
 assert.equal(q.providerAmountMinor,'81');
 assert.equal(q.walletDeltaMinor,'-81');
});

test('settlement cannot change the derived wallet amount or use wrong rate side',()=>{
 const q=input('deposit_cash_send_provider','UGX','SSP','100','50000000');
 assert.throws(()=>quote({...q,providerAmountMinor:'4999'}),/Provider amount does not match/);
 assert.throws(()=>quote({...q,rateSide:'buy'}),/Wrong approved/);
 assert.throws(()=>quote({...q,cashCurrency:'UGX'}),/different currencies/);
 assert.throws(()=>quote({...q,rateDecimal:'1000000000',cashAmountMinor:'1'}),/converts to zero/);
});
