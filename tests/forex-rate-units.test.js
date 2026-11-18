'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const rate=require('../src/tenant/services/forexRateUnits.service');
const fx=require('../src/tenant/services/forex.service');

test('UGX KES SSP rates display per 1000, USD per 1, without changing journal rate convention',()=>{
 for(const code of ['UGX','KES','SSP'])assert.equal(rate.basis(code),1000);
 assert.equal(rate.basis('USD'),1);
 assert.deepEqual(rate.display('4','UGX'),{units:1000,rate:'4000',text:'1,000 UGX'});
 assert.deepEqual(rate.display('0.000275','UGX'),{units:1000,rate:'0.275',text:'1,000 UGX'});
 assert.deepEqual(rate.display('4','KES'),{units:1000,rate:'4000',text:'1,000 KES'});
 assert.equal(rate.display('4000','UGX').rate,'4000000','Historical per-unit rates are never automatically divided by 1000');
});
test('FX rate editor normalizes actual target amount for 1000 source units exactly',()=>{
 assert.equal(rate.normalize({quotedRate:'4000',rateBaseUnits:'1000'}),'4');
 assert.equal(rate.normalize({quotedRate:'0.275',rateBaseUnits:'1000'}),'0.000275');
 assert.equal(rate.normalize({quotedRate:'3',rateBaseUnits:'1'}),'3');
 assert.equal(fx.rateInput({fromCurrency:'UGX',toCurrency:'SSP',side:'buy',
  quotedRate:'4000',rateBaseUnits:'1000',validHours:'24',
  note:'Actual branch rate verified by operator'}).rateDecimal,'4');
});
test('reject unsupported base, imprecise normalized rate and invented negative or scientific inputs',()=>{
 for(const units of ['2','0','10000',null])assert.throws(()=>rate.normalize({quotedRate:'4000',rateBaseUnits:units}),/source units/);
 for(const value of ['-10','1e4','0','0.','1.123456789',' 4','01'])assert.throws(()=>rate.normalize({quotedRate:value,rateBaseUnits:'1000'}),/rate/);
 assert.throws(()=>rate.normalize({quotedRate:'0.00000001',rateBaseUnits:'1000'}),/precision/);
});
