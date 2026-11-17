'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs'),path=require('node:path');
const view=path.resolve(__dirname,'../src/views/tenant/money-transfer/interbranch-cash.ejs');
const ids={source:'507f1f77bcf86cd799439010',review:'507f1f77bcf86cd799439011'};
function values(overrides={}){
 return {csrfToken:'sample-csrf',
  user:{id:'507f1f77bcf86cd799439012',role:'Tenant Owner'},
  data:{
   order:{_id:ids.source,reference:'TRANSFER-BRANCH-001',status:'paid_out_manual',
    amountMinor:'10000',currency:'UGX',payoutCurrency:null,payoutMinor:null,
    originBranchName:'Sending branch',destinationBranchName:'Receiving branch'},
   reimbursements:[{id:ids.review,status:'pending_review',amount:'UGX 10,000',
    requestedBy:'507f1f77bcf86cd799439013',note:'<img src=x onerror=alert(1)>'}],
   enabled:true,crossCurrency:false,canReview:true,canRequest:false,
   idempotencyKey:'e3d9d4bf-6c6a-4d45-904a-9e11a2fc16e2',
   formatMoneyMinor:(minor,currency)=>currency+' '+Number(minor).toLocaleString('en-US'),
   ...overrides
  }
 };
}
test('sending/receiving balances remain in original UGX; separate signed receipts required',async()=>{
 const html=await ejs.renderFile(view,values());
 assert.match(html,/UGX 10,000/);
 assert.match(html,/name="senderHandoverReference"/);
 assert.match(html,/name="receiverReceiptReference"/);
 assert.match(html,/name="bothBranchesVerified" value="confirmed"/);
 assert.match(html,/Approve verified interbranch cash reimbursement/);
 assert.match(html,/name="_csrf" value="sample-csrf"/);
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.doesNotMatch(html,/<img src=x onerror/);
});
test('receiving cashier, not sender or owner, gets a real independent cash count confirmation form',async()=>{
 const data=values({
  canRequest:false,canConfirm:true,canReview:false,
  reimbursements:[{id:ids.review,status:'pending_receiver',amount:'UGX 10,000',
   requestedBy:'507f1f77bcf86cd799439013',note:'Original sender signed handover',
   senderOriginalEvidence:'SOURCE-HANDOVER-REFERENCE'}]
 });
 const html=await ejs.renderFile(view,data);
 assert.match(html,/Confirm counted branch cash receipt/);
 assert.match(html,/name="receiverReceiptReference"/);
 assert.match(html,/name="cashCountConfirmed" value="confirmed"/);
 assert.doesNotMatch(html,/Approve verified interbranch cash reimbursement/);
 assert.match(html,/SOURCE-HANDOVER-REFERENCE/);
});
test('different SSP/USD recipient currency cannot render a posting form',async()=>{
 const html=await ejs.renderFile(view,values({
  crossCurrency:true,canRequest:false,canReview:false,
  order:{...values().data.order,currency:'SSP',payoutCurrency:'USD',amountMinor:'65000',payoutMinor:'500'}
 }));
 assert.match(html,/SSP payable cannot simply be offset against USD receivable/);
 assert.doesNotMatch(html,/<form[^>]*action="[^"]*interbranch-cash/);
});
test('feature flag off reveals no cash movement or approvals',async()=>{
 const html=await ejs.renderFile(view,values({
  enabled:false,canRequest:false,canReview:false
 }));
 assert.match(html,/Interbranch posting is disabled/);
 assert.doesNotMatch(html,/Approve verified interbranch cash reimbursement/);
});
test('original collecting teller can request, not review',async()=>{
 const html=await ejs.renderFile(view,values({
  reimbursements:[],canRequest:true,canReview:false
 }));
 assert.match(html,/Request independent branch reimbursement review/);
 assert.match(html,/name="idempotencyKey"/);
 assert.doesNotMatch(html,/Approve verified interbranch cash reimbursement/);
});
