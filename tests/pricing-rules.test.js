'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const pricing=require('../src/tenant/pricing/service');
const branch='507f1f77bcf86cd799439011',other='507f1f77bcf86cd799439012',id='507f1f77bcf86cd799439013';
function rule(overrides={}){return{_id:id,operation:'mobile_money.cash_in',currency:'SSP',network:'',branchId:null,enabled:true,revision:3,fixedFeeMinor:'25',feeBps:125,fixedCostMinor:'10',costBps:50,...overrides};}
test('pricing stores exact currency minor amounts and basis points rather than floating point prices',()=>{
 const input=pricing.validate({operation:'money_transfer.send',currency:'SSP',feeFixed:'1.25',feePercent:'1.25',costFixed:'0.09',costPercent:'0.75',enabled:'true'});
 assert.equal(input.fixedFeeMinor,'125');assert.equal(input.feeBps,125);assert.equal(input.fixedCostMinor,'9');assert.equal(input.costBps,75);assert.equal(input.branchId,null);
 assert.equal(pricing.decimalMinor('123','UGX'),'123');assert.equal(pricing.decimalMinor('001.20','USD'),'120');assert.equal(pricing.percentage('100'),10000);
 for(const value of ['0.01','1.0'])assert.throws(()=>pricing.decimalMinor(value,'UGX'),error=>error.status===400);
 for(const value of ['-1','1e3','10000000000.01','NaN'])assert.throws(()=>pricing.decimalMinor(value,'USD'),error=>error.status===400);
 for(const value of ['100.01','-1','1.001','1e2'])assert.throws(()=>pricing.percentage(value),error=>error.status===400);
});
test('branch pricing overrides tenant defaults and network pricing only overrides within its matching scope',()=>{
 const tenant=rule(),network=rule({_id:other,network:'MTN SSD'}),specific=rule({_id:branch,branchId:branch});
 assert.equal(pricing.select([tenant,network,specific],{operation:tenant.operation,currency:'SSP',branchId:branch,network:'MTN SSD'}),specific);
 assert.equal(pricing.select([tenant,network,specific],{operation:tenant.operation,currency:'SSP',branchId:other,network:'MTN SSD'}),network);
 assert.equal(pricing.select([tenant,network,specific],{operation:tenant.operation,currency:'SSP',branchId:other,network:'MTN'}),tenant);
 assert.equal(pricing.select([rule({enabled:false})],{operation:tenant.operation,currency:'SSP'}),null);
 assert.equal(pricing.select([tenant],{operation:'money_transfer.send',currency:'SSP'}),null);
 assert.equal(pricing.select([tenant],{operation:tenant.operation,currency:'USD'}),null);
});
test('automatic charges and separate estimated costs round half up in currency minor units',()=>{
 const snapshot=pricing.snapshot(rule(),'10001','SSP');
 assert.deepEqual(snapshot,{policyId:id,revision:3,operation:'mobile_money.cash_in',currency:'SSP',feeMinor:'150',costMinor:'60',fixedFeeMinor:'25',feeBps:125,fixedCostMinor:'10',costBps:50});
 assert.equal(pricing.snapshot(rule({fixedFeeMinor:'0',feeBps:5000}),'1','SSP').feeMinor,'1');
 assert.equal(pricing.snapshot(null,'999999999999999999999999','USD').feeMinor,'0');
 assert.throws(()=>pricing.snapshot(rule(),'100','USD'),error=>error.status===409);
 assert.throws(()=>pricing.snapshot(rule({feeBps:10001}),'100','SSP'),error=>error.status===409);
 assert.throws(()=>pricing.snapshot(rule({revision:-1}),'100','SSP'),error=>error.status===409);
});
test('pricing configuration rejects routing injections, unsupported networks and operation currencies',()=>{
 for(const input of [{tenantId:id},{updatedBy:id},{feeFixed:[]},{feePercent:[]},{branchId:'invalid'},{network:'Unknown'},{enabled:'sometimes'}])assert.throws(()=>pricing.validate({operation:'mobile_money.cash_in',currency:'USD',...input}),error=>error.status===400);
 assert.throws(()=>pricing.validate({operation:'banking.deposit',currency:'USD',network:'MTN'}),error=>error.status===400);
 assert.throws(()=>pricing.validate({operation:'money_transfer.send',currency:'EUR'}),error=>error.status===400);
 assert.equal(pricing.validate({operation:'forex.quote',currency:'EUR',feeFixed:'0.10'}).fixedFeeMinor,'10');
 assert.equal(pricing.validate({operation:'mobile_money.cash_out',currency:'SSP',network:'MTN SSD',branchId:branch}).network,'MTN SSD');
});
