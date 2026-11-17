'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const path=require('node:path');
const template=path.resolve(__dirname,'../src/views/tenant/money-transfer/refund.ejs');
const refund={id:'507f1f77bcf86cd799439011',status:'pending_review',
 requestedBy:'507f1f77bcf86cd799439012',reason:'Customer <script> refuses payout',
 reviewNote:null,amount:'SSP 14.00'};
function context(overrides={}){
 return {
  csrfToken:'real-csrf',user:{id:'507f1f77bcf86cd799439013',role:'Reconciliation Officer'},
  data:{
   order:{_id:'507f1f77bcf86cd799439014',reference:'TR-SENDER-01',
    status:'collected_manual',currency:'SSP',amountMinor:'1300',feeMinor:'100',
    payoutCurrency:'USD',payoutMinor:'10',sender:{phone:'+211921234567'}},
   refunds:[refund],enabled:true,canReview:true,canRequest:false,
   idempotencyKey:'0e7ef0bb-a93a-4c87-94ad-9d282d81bb4d',
   formatMoneyMinor:(minor,currency)=>currency+' '+(Number(minor)/100).toFixed(2),
   ...overrides
  }
 };
}
test('approved layout uses original sender SSP, not USD payout currency, and displays reviewer-only controls',async()=>{
 const html=await ejs.renderFile(template,context());
 assert.match(html,/Original sender collection/);
 assert.match(html,/SSP 13\.00/);
 assert.match(html,/Original recorded service fee/);
 assert.match(html,/SSP 1\.00/);
 assert.match(html,/USD 0\.10/);
 assert.match(html,/Approve verified cash refund/);
 assert.match(html,/name="signedReceiptReference"/);
 assert.match(html,/name="cashHandoverConfirmed" value="confirmed"/);
 assert.match(html,/name="_csrf" value="real-csrf"/);
 assert.match(html,/&lt;script&gt;/);
 assert.doesNotMatch(html,/<script>/);
});
test('posted cash refund shows independently signed sender receipt and exact Treasury compensation',async()=>{
 const record={...refund,status:'posted_refund',reviewNote:'Signed refund handover verified',
  signedReceiptReference:'SIGNED-SSP-REFUND-2026',compensationBatch:'507f1f77bcf86cd799439019'};
 const html=await ejs.renderFile(template,context({refunds:[record],canReview:false}));
 assert.match(html,/SIGNED-SSP-REFUND-2026/);
 assert.match(html,/507f1f77bcf86cd799439019/);
 assert.doesNotMatch(html,/Approve verified cash refund/);
});
test('disabled refunds show a real blocker and cannot submit a refund or review',async()=>{
 const html=await ejs.renderFile(template,context({enabled:false,canRequest:false,canReview:false}));
 assert.match(html,/Refund posting is disabled/);
 assert.doesNotMatch(html,/<form[^>]+action="[^"]*refund/);
 assert.doesNotMatch(html,/Approve verified cash refund/);
});
test('original cashier can request a refund but never self approve',async()=>{
 const local=context({canRequest:true,canReview:false,refunds:[]});
 const html=await ejs.renderFile(template,local);
 assert.match(html,/Request independent refund review/);
 assert.match(html,/name="idempotencyKey"/);
 assert.match(html,/name="senderPhone"/);
 assert.doesNotMatch(html,/Approve verified cash refund/);
});
