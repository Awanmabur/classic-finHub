'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const mongoose=require('mongoose');
const policy=require('../src/tenant/services/branchCurrency.service');
const branches=require('../src/tenant/services/branch.service');
const cash=require('../src/tenant/services/cashDrawer.service');
test('legacy branches and new branch defaults support all four currencies without rewriting the default',()=>{
 const branch={currency:'UGX'};assert.deepEqual(policy.supported(branch),['UGX','USD','SSP','KES']);assert.equal(policy.resolve(branch),'UGX');assert.equal(policy.resolve(branch,'SSP'),'SSP');assert.equal(branch.currency,'UGX');
 const Model=mongoose.model('BranchCurrenciesTest',require('../src/tenant/models/Branch'));const row=new Model({name:'Main',code:'main',currency:'UGX',createdBy:new mongoose.Types.ObjectId(),updatedBy:new mongoose.Types.ObjectId()});assert.deepEqual([...row.currencies],policy.supported(branch));assert.equal(row.validateSync(),undefined);
});
test('explicit selected currencies are authoritative and malformed or empty stored lists fail closed',()=>{
 const branch={currency:'UGX',currencies:['SSP','UGX']};assert.deepEqual(policy.supported(branch),['UGX','SSP']);assert.deepEqual(policy.options(branch).map(option=>option.code),['UGX','SSP']);
 for(const selected of ['USD','EUR','KSH',{},['UGX']])assert.throws(()=>policy.resolve(branch,selected),{status:409});
 for(const currencies of [[],['UGX','UGX'],['EUR'],'UGX'])assert.deepEqual(policy.supported({currency:'UGX',currencies}),[]);
});
test('branch configuration rejects duplicate, unsupported, omitted-all and excluded default currencies',()=>{
 const base={name:'Main',code:'main',currency:'UGX'};
 assert.deepEqual(branches.validate({...base,currencies:['USD','UGX']},true).currencies,['UGX','USD']);
 for(const currencies of [[],['USD'],['UGX','UGX'],['UGX','EUR']])assert.throws(()=>branches.validate({...base,currencies},true),{status:400});
 assert.throws(()=>branches.validate({...base,currenciesConfigured:'1'},true),{status:400});
});
test('cash identity separates each currency while the legacy fallback still requires matching currency',()=>{
 const branch=new mongoose.Types.ObjectId(),actor=new mongoose.Types.ObjectId();
 assert.notEqual(cash.key(branch,actor,'UGX'),cash.key(branch,actor,'USD'));
 const filter=cash.activeFilter(branch,actor,'USD');assert.equal(filter.currency,'USD');assert.deepEqual(filter.activeKey.$in,[`${branch}:${actor}:USD`,`${branch}:${actor}`]);assert.equal(String(filter.branchId),String(branch));assert.equal(String(filter.operatorId),String(actor));
 assert.throws(()=>cash.key(branch,actor,'EUR'),{status:400});
});
