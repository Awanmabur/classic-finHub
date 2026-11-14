'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validate}=require('../src/tenant/services/mobileMoney.service');
const {randomUUID}=require('node:crypto');

function input(network,currency,amount='1000'){
 return {network,currency,amount,fee:'0',customerPhone:'+256771234567',
  networkReference:'NETWORK-REF-20261114',idempotencyKey:randomUUID(),paymentMethod:'Cash'};
}
test('provider identity determines fixed market currency on deposit',()=>{
 const south=validate(input('MTN SSD','SSP','1000.00'),'cash_in');
 assert.equal(south.currency,'SSP');
 assert.equal(south.amountMinor,100000);
 const ug=validate(input('MTN','UGX','1000'),'cash_in');
 assert.equal(ug.currency,'UGX');
 const airtel=validate(input('Airtel','UGX','1000'),'cash_out');
 assert.equal(airtel.currency,'UGX');
});
test('reject user-supplied currency conflicting with known network market',()=>{
 assert.throws(()=>validate(input('MTN SSD','UGX'),'cash_out'),/network determines the currency/);
 assert.throws(()=>validate(input('MTN','SSP'),'cash_in'),/network determines the currency/);
 assert.throws(()=>validate(input('Airtel','KES'),'cash_in'),/network determines the currency/);
});
