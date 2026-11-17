'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs'),path=require('node:path');
const view=path.resolve(__dirname,'../src/views/tenant/money-transfer/acknowledgement.ejs');
const record={_id:'507f1f77bcf86cd799439010',reference:'MT-CASH-REF-1',
 status:'refunded_manual',currency:'SSP',amountMinor:'1300',feeMinor:'100',
 payoutCurrency:'USD',payoutMinor:'10',fxRateDecimal:'130',
 branchId:'507f1f77bcf86cd799439011',
 originBranchName:'Sender branch',destinationBranchName:'Receiving branch',
 sender:{name:'Verified <script>sender',country:'SS'},
 beneficiary:{name:'Verified receiver',country:'SS'},
 createdAt:new Date('2026-11-17T08:00:00Z'),expiresAt:new Date('2026-11-17T18:00:00Z')};
const context=(order)=>({order,tenant:{name:'Test tenant'},csrfToken:'scrubbed',
 assetVersion:'test',businessTimeZone:'Africa/Juba',
 formatMoneyMinor:(minor,currency)=>currency+' '+(Number(minor)/100).toFixed(2)});
test('printed internal transfer acknowledgement never lies that refunded sender cash was never collected',async()=>{
 const html=await ejs.renderFile(view,context(record));
 assert.match(html,/SENDER CASH REFUNDED IN INTERNAL BOOKS/);
 assert.match(html,/Original sender collection amount/);
 assert.match(html,/Originally intended recipient payout \(not paid\)/);
 assert.match(html,/The original recipient PIN has been closed/);
 assert.match(html,/signed sender receipt and linked audit record/);
 assert.match(html,/This does not claim external provider settlement/);
 assert.doesNotMatch(html,/No funds have been collected/);
 assert.match(html,/Verified &lt;script&gt;sender/);
 assert.doesNotMatch(html,/<script>sender/);
});
test('an unpaid transfer receipt keeps its original nonpayment warning, never claims a refund',async()=>{
 const html=await ejs.renderFile(view,context({...record,status:'requested'}));
 assert.match(html,/NOT A PAYMENT RECEIPT/);
 assert.doesNotMatch(html,/SENDER CASH REFUNDED IN INTERNAL BOOKS/);
 assert.match(html,/The receiver must complete PIN and identity checks/);
});
