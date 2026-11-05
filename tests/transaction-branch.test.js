'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveTransactionBranch,assignedBranchId,requestContext}=require('../src/tenant/services/transactionBranch.service');
const first={_id:'507f1f77bcf86cd799439011',name:'Kampala',currency:'UGX',status:'active'};
const second={_id:'507f1f77bcf86cd799439012',name:'Nairobi',currency:'KES',status:'active'};
function model(values){return {
  findOne:filter=>({lean:async()=>values.find(b=>String(b._id)===String(filter._id)&&b.status===filter.status)||null}),
  find:filter=>({sort(){return this;},limit(){return this;},lean:async()=>values.filter(b=>b.status===filter.status).slice(0,2)})
};}
const owner={id:'507f1f77bcf86cd799439013',role:'Tenant Owner',branchId:null};
test('account branch is authoritative for staff and owners; forged branch fields fail',async()=>{
  for(const role of ['Tenant Owner','Mobile Money Operator']){
    const actor={...owner,role,branchId:first._id};
    assert.equal(assignedBranchId(actor,{}),first._id);
    assert.equal((await resolveTransactionBranch(null,actor,{}, {Branch:model([first,second])})).currency,'UGX');
    await assert.rejects(resolveTransactionBranch(null,actor,{branchId:second._id},{Branch:model([first,second])}),{status:403});
    await assert.rejects(resolveTransactionBranch(null,{...actor,transactionBranchId:second._id},{},{Branch:model([first,second])}),{status:403});
  }
});
test('an unassigned owner gets the sole active location without trusting client input',async()=>{
  assert.equal((await resolveTransactionBranch(null,owner,{}, {Branch:model([first])}))._id,first._id);
  await assert.rejects(resolveTransactionBranch(null,owner,{branchId:second._id},{Branch:model([first])}),{status:403});
  await assert.rejects(resolveTransactionBranch(null,{...owner,role:'Mobile Money Operator'}, {},{Branch:model([first])}),{status:403});
});
test('multiple locations and archived assignments cannot silently choose another branch',async()=>{
  await assert.rejects(resolveTransactionBranch(null,owner,{}, {Branch:model([first,second])}),{status:409});
  await assert.rejects(resolveTransactionBranch(null,owner,{}, {Branch:model([])}),{status:409});
  await assert.rejects(resolveTransactionBranch(null,{...owner,branchId:first._id},{}, {Branch:model([{...first,status:'archived'},second])}),{status:403});
});
