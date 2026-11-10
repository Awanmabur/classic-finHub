'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const presentation=require('../src/tenant/pricing/presentation');
test('normal teller forms receive only their module rules and public calculation fields',()=>{
 const rules=[{_id:'rule',revision:3,branchId:'main',operation:'money_transfer.send',currency:'USD',network:'',fixedFeeMinor:'125',feeBps:200,fixedCostMinor:'10',costBps:50,enabled:true,tenantId:'private-tenant',createdBy:'private-admin',updatedBy:'private-editor',createdAt:new Date()},
  {operation:'forex.buy',currency:'USD',fixedFeeMinor:'999'}];
 const result=presentation.project(rules,'money_transfer');
 assert.equal(result.length,1);assert.equal(result[0].fixedFeeMinor,'125');assert.equal(result[0].costBps,50);assert.equal(result[0].revision,3);
 for(const field of ['tenantId','createdBy','updatedBy','createdAt'])assert.equal(Object.hasOwn(result[0],field),false);
 assert.equal(rules[0].createdBy,'private-admin','projection does not mutate persisted policy objects');
});
test('a form with no operating branch cannot receive branch policy context',async()=>{
 assert.deepEqual(await presentation.context({}, {_id:'tenant'},null,'money_transfer'),[]);
});
