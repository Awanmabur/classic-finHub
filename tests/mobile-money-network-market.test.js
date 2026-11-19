'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validate,manualReference}=require('../src/tenant/services/mobileMoney.service');
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

test('manual transaction IDs are server generated, stable for retries, unique for new requests',()=>{
 const first=randomUUID(),second=randomUUID();
 assert.equal(manualReference(first),'TX-'+first);
 assert.equal(manualReference(first),manualReference(first),'retry must retain the same internal ID');
 assert.notEqual(manualReference(first),manualReference(second),'separate requests require separate IDs');
 assert.throws(()=>manualReference(''),/Expired form reference/);
 assert.throws(()=>manualReference('cashier-supplied'),/Expired form reference/);
});
test('SMS-extracted provider reference remains distinct from a manual TX identifier',()=>{
 const sms=input('MTN','UGX');
 const normalized=validate(sms,'cash_in');
 assert.equal(normalized.networkReference,'NETWORK-REF-20261114');
 assert.notEqual(normalized.networkReference,manualReference(sms.idempotencyKey));
});
