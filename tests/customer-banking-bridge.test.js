'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const bridge=require('../src/tenant/customerAccounts/bankingBridge');
const id='507f1f77bcf86cd799439011';
test('Banking selectors distinguish internal accounts from legacy masked references',()=>{
 assert.equal(bridge.parseSelection(id.toUpperCase()),id);assert.equal(bridge.parseSelection('account:'+id.toUpperCase()),'account:'+id);
 assert.deepEqual(bridge.decodeSelection('account:'+id),{type:'customer_account',id,value:'account:'+id});
 for(const value of [null,{},'account:../../other','account:','bank:'+id,'ACCOUNT:'+id,'account:'+id+'extra'])assert.throws(()=>bridge.parseSelection(value),error=>error.status===400);
});
test('Request idempotency matches both account ID and identity namespace',()=>{
 const customer={referenceId:id,referenceType:'customer_account'},legacy={referenceId:id};
 assert.equal(bridge.matches(customer,'account:'+id),true);assert.equal(bridge.matches(customer,id),false);
 assert.equal(bridge.matches(legacy,id),true);assert.equal(bridge.matches(legacy,'account:'+id),false);
 assert.equal(bridge.matches(null,id),false);assert.equal(bridge.matches({referenceId:'507f1f77bcf86cd799439012',referenceType:'customer_account'},'account:'+id),false);
});
