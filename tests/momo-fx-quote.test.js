'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {quote}=require('../src/tenant/services/momoFxQuote.service');
const base={
 providerCurrency:'UGX',cashCurrency:'SSP',providerAmountMinor:'100000',
 rateDecimal:'0.9',rateId:'aaaaaaaaaaaaaaaaaaaaaaaa',
 rateVersion:1,approved:true,expiresAt:'2099-01-01T00:00:00.000Z'
};
test('UGX withdrawal credits float and debits SSP cash',()=>{
 const q=quote({...base,operation:'withdraw_provider_receive_cash',rateSide:'buy'});
 assert.equal(q.walletDeltaMinor,'100000');
 assert.equal(q.cashDeltaMinor,'-9000');
 assert.equal(q.cashAmountMinor,'9000');
 assert.equal(q.postingAuthorized,false);
});
test('SSP deposit debits float and credits cash',()=>{
 const q=quote({...base,operation:'deposit_cash_send_provider',rateSide:'sell'});
 assert.equal(q.walletDeltaMinor,'-100000');
 assert.equal(q.cashDeltaMinor,'9000');
});
test('wrong Buy/Sell rate is rejected',()=>{
 assert.throws(()=>quote({...base,operation:'withdraw_provider_receive_cash',rateSide:'sell'}),/Wrong approved/);
});
test('expired or unapproved rate is rejected',()=>{
 assert.throws(()=>quote({...base,operation:'withdraw_provider_receive_cash',rateSide:'buy',approved:false}),/approved rate/);
 assert.throws(()=>quote({...base,operation:'withdraw_provider_receive_cash',rateSide:'buy',expiresAt:'2020-01-01T00:00:00Z'}),/expired/);
});
test('unsupported currencies and same currency are rejected',()=>{
 assert.throws(()=>quote({...base,operation:'withdraw_provider_receive_cash',rateSide:'buy',cashCurrency:'UGX'}),/different/);
 assert.throws(()=>quote({...base,operation:'withdraw_provider_receive_cash',rateSide:'buy',cashCurrency:'XYZ'}),/Unsupported/);
});
test('reject negative, nonintegral and zero amounts',()=>{
 for(const amount of ['-2','1.5','0','01','1e8'])assert.throws(()=>quote({...base,operation:'withdraw_provider_receive_cash',rateSide:'buy',providerAmountMinor:amount}),/Invalid provider/);
});
test('round exactly in minor units without floating point',()=>{
 const q=quote({...base,providerCurrency:'USD',cashCurrency:'SSP',providerAmountMinor:'101',rateDecimal:'0.505',operation:'withdraw_provider_receive_cash',rateSide:'buy'});
 assert.equal(q.cashAmountMinor,'51');
});
test('reject invalid, ambiguous or zero rate',()=>{
 for(const rateDecimal of ['0','-1','1e5','1.123456789','01','2.'])assert.throws(()=>quote({...base,operation:'withdraw_provider_receive_cash',rateSide:'buy',rateDecimal}),/rate/);
});
