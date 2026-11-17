'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const verification=require('../src/tenant/funded/branchTransfer');
const core=require('../src/tenant/models');
const funded=require('../src/tenant/funded/models');
const auth=require('../src/tenant/services/financialAuthorization.service');
const operations=require('../src/tenant/services/fundedOperations.service');
const ids={tenant:'507f1f77bcf86cd799439010',branch:'507f1f77bcf86cd799439011',
 destination:'507f1f77bcf86cd799439012',pay:'507f1f77bcf86cd799439013',
 collect:'507f1f77bcf86cd799439014',order:'507f1f77bcf86cd799439015',
 reviewer:'507f1f77bcf86cd799439016',payer:'507f1f77bcf86cd799439017',
 clearing:'507f1f77bcf86cd799439018'};
function fixtures({sameBranch=true,payoutCurrency='USD',wrongClearing=false}={}){
 const recipientBranch=sameBranch?ids.branch:ids.destination;
 return {
  source:{_id:ids.order,branchId:ids.branch,destinationBranchId:recipientBranch,
   currency:'SSP',payoutCurrency,manualCollectionExecutionId:ids.collect},
  execution:{_id:ids.pay,action:'transfer_payout',sourceType:'money_transfer',
   sourceId:ids.order,collectionExecutionId:ids.collect,branchId:recipientBranch,
   createdBy:ids.payer,accounts:{clearingAccountId:ids.clearing}},
  collection:{_id:ids.collect,action:'transfer_collect',sourceType:'money_transfer',
   sourceId:ids.order,branchId:ids.branch,createdBy:ids.payer,
   accounts:{clearingAccountId:wrongClearing?ids.order:ids.clearing}}
 };
}
function mockSetup(t,fixture){
 const queryable=value=>({session(){return this;},lean:async()=>value});
 const reviewer={_id:ids.reviewer,role:'Reconciliation Officer',
  branchId:fixture.execution.branchId,status:'active'};
 t.mock.method(auth,'fenceAction',async()=>({tenant:{_id:ids.tenant},actor:{id:ids.reviewer}}));
 t.mock.method(core,'tenantUserModel',()=>({findOne:()=>queryable(reviewer)}));
 t.mock.method(core,'transferOrderModel',()=>({findOne:()=>queryable(fixture.source)}));
 t.mock.method(funded,'models',()=>({execution:{findOne:q=>
  queryable(q.action==='transfer_payout'?fixture.execution:fixture.collection)}}));
 t.mock.method(operations,'sourceMatches',()=>true);
}
const session={inTransaction:()=>true},conn={};
test('two different cashiers may settle a rate-approved same-branch transfer with separate cash currencies',async t=>{
 const fixture=fixtures();
 mockSetup(t,fixture);
 const result=await verification.validate(conn,session,{_id:ids.tenant},{id:ids.reviewer},ids.pay);
 assert.equal(result.sameBranch,true);
 assert.equal(result.source.payoutCurrency,'USD');
 assert.equal(result.collection.accounts.clearingAccountId,ids.clearing);
});
test('ordinary same-currency transfers cannot enter special dual-teller FX release',async t=>{
 mockSetup(t,fixtures({payoutCurrency:null}));
 await assert.rejects(
  verification.validate(conn,session,{_id:ids.tenant},{id:ids.reviewer},ids.pay),
  {status:409}
 );
});
test('different-branch transfers still preserve the existing independently reviewed route',async t=>{
 mockSetup(t,fixtures({sameBranch:false,payoutCurrency:null}));
 const result=await verification.validate(conn,session,{_id:ids.tenant},{id:ids.reviewer},ids.pay);
 assert.equal(result.sameBranch,false);
 assert.equal(result.execution.branchId,ids.destination);
});
test('a mismatched collected clearing account cannot be released into a recipient drawer',async t=>{
 mockSetup(t,fixtures({wrongClearing:true}));
 await assert.rejects(
  verification.validate(conn,session,{_id:ids.tenant},{id:ids.reviewer},ids.pay),
  {status:409}
 );
});
test('the cross-currency settlement cannot bypass its active financial database transaction',async()=>{
 await assert.rejects(
  verification.validate(conn,{inTransaction:()=>false},{_id:ids.tenant},{id:ids.reviewer},ids.pay),
  {status:409}
 );
});
