'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const refund=require('../src/tenant/refunds/service');
const {schema}=require('../src/tenant/refunds/models');
const id={source:'507f1f77bcf86cd799439010',branch:'507f1f77bcf86cd799439011',
 teller:'507f1f77bcf86cd799439012',cash:'507f1f77bcf86cd799439013',
 payable:'507f1f77bcf86cd799439014'};
const source={_id:id.source,branchId:id.branch,createdBy:id.teller,
 currency:'SSP',amountMinor:'1300',feeMinor:'100',capture:{method:'Cash'},
 manualCollectionExecutionId:'507f1f77bcf86cd799439015'};
const collection={_id:source.manualCollectionExecutionId,branchId:id.branch,
 sourceId:source._id,sourceType:'money_transfer',action:'transfer_collect',
 status:'posted_manual',createdBy:id.teller,
 accounts:{collectionAccountId:id.cash,clearingAccountId:id.payable}};
test('refund must repay the original sender cash AND the actually collected fee in original SSP denomination',()=>{
 assert.deepEqual(refund.cashMethod(source,collection),{
  principalMinor:'1300',feeMinor:'100',totalMinor:'1400',currency:'SSP',cashAccountId:id.cash
 });
});
test('original cash cannot be replaced with a wallet, bank or different cashier/branch',()=>{
 const variants=[
  [{...source,capture:{method:'Mobile Money'}},collection],
  [{...source,manualCollectionExecutionId:'507f1f77bcf86cd799439019'},collection],
  [source,{...collection,createdBy:'507f1f77bcf86cd799439019'}],
  [source,{...collection,branchId:'507f1f77bcf86cd799439019'}],
  [source,{...collection,accounts:{...collection.accounts,collectionAccountId:null}}],
  [source,{...collection,status:'pending_review'}]
 ];
 for(const [a,b]of variants)assert.throws(()=>refund.cashMethod(a,b),{status:409});
});
test('invalid or malicious sender proof, incomplete request, negative amount and fabricated cash are rejected',()=>{
 const request={idempotencyKey:crypto.randomUUID(),senderPhone:'+211921234567',
  reason:'Sender attended to request the refund',evidenceReference:'IDENTITY-REFERENCE'};
 assert.equal(refund.requestInput(request).senderPhone,request.senderPhone);
 assert.throws(()=>refund.requestInput({...request,idempotencyKey:'forged'}),{status:400});
 assert.throws(()=>refund.requestInput({...request,evidenceReference:'<script>'}),{status:400});
 assert.throws(()=>refund.requestInput({...request,reason:'x'}),{status:400});
 assert.throws(()=>refund.cashMethod({...source,amountMinor:'-1'},collection),{status:409});
 assert.throws(()=>refund.cashMethod({...source,feeMinor:'notmoney'},collection),{status:409});
});
test('refund posting remains disabled by default, even if a user could submit a forged form',async()=>{
 const old=process.env.CLASSICFIN_LINKED_CURRENCY_REFUNDS;
 delete process.env.CLASSICFIN_LINKED_CURRENCY_REFUNDS;
 try{
  await assert.rejects(refund.request({name:'demo'},{slug:'nope'},{
   id:id.teller,permissions:['*'],role:'Tenant Owner'
  },id.source,{}),{status:403});
 }finally{
  if(old===undefined)delete process.env.CLASSICFIN_LINKED_CURRENCY_REFUNDS;
  else process.env.CLASSICFIN_LINKED_CURRENCY_REFUNDS=old;
 }
});
test('refund evidence has one unique financial retry key and one active sender cash correction per original',()=>{
 const indexed=schema.indexes();
 assert(indexed.some(([fields,opt])=>fields.idempotencyKey===1&&opt.unique));
 assert(indexed.some(([fields,opt])=>fields.activeKey===1&&opt.unique));
 assert(schema.path('status').enumValues.includes('posted_refund'));
 assert(!schema.path('status').enumValues.includes('provider_confirmed'));
});
