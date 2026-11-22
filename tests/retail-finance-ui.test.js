'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const ejs=require('ejs'),path=require('node:path');
const id='507f1f77bcf86cd799439011',other='507f191e810c19729de860ea';
const file=x=>path.join(__dirname,'../src/views/tenant/',x);
const fmt=(n,c)=>c+' '+String(n);
const shared={user:{id,role:'Tenant Owner'},csrfToken:'test-csrf'};
test('loan portfolio, borrower and product forms render with CSRF and no second customer entitlement',async()=>{
 const html=await ejs.renderFile(file('loans/index.ejs'),{...shared,data:{
  summary:[{currency:'UGX',principalOutstanding:'250',interestOutstanding:'5',late:0}],
  loans:[],products:[],funds:[],customers:[],format:fmt,uuid:'uuid-app',borrowerUuid:'uuid-borrower',
  canManage:true,canCreate:true,branch:{_id:id,currency:'UGX'},activeCurrency:'UGX',
  currencyChoices:['UGX','SSP'],formatDate:()=> '2026-11-22'
 }});
 assert.match(html,/action="\/tenant\/loans\/borrowers"/);
 assert.match(html,/name="idempotencyKey" value="uuid-borrower"/);
 assert.match(html,/action="\/tenant\/loans\/applications"/);
 assert.match(html,/action="\/tenant\/loans\/products"/);
 assert.match(html,/name="_csrf" value="test-csrf"/);
 assert.match(html,/Flat interest \(basis points\)/);
 assert.doesNotMatch(html,/name="branchId"/);
});
test('loan detail retains original repayment and independent correction controls',async()=>{
 const loan={_id:other,applicationRef:'LN-REAL',status:'active',currency:'UGX',reason:'Real money evidence',
  customerId:id,branchId:id,principalMinor:'20000',interestMinor:'1000',principalOutstandingMinor:'5000',
  interestOutstandingMinor:'0',dueAt:new Date('2026-11-24T12:00:00Z')};
 const payment={_id:'507f1f77bcf86cd799439055',createdBy:other,createdAt:new Date('2026-11-22T12:00:00Z'),
  amountMinor:'1000',principalMinor:'900',interestMinor:'100',currency:'UGX',reference:'RECEIPT-REAL'};
 const html=await ejs.renderFile(file('loans/detail.ejs'),{...shared,data:{
  loan,payments:[payment],customer:{name:'Borrower'},corrections:[],funds:[{_id:id,name:'Bank',branchId:id,currency:'UGX'}],
  uuid:'repay-ref',format:fmt,formatDate:()=> '2026-11-22',canReview:false,canRepay:true,canDisburse:false,canCorrect:true
 }});
 assert.match(html,/action="\/tenant\/loans\/507f191e810c19729de860ea\/repay"/);
 assert.match(html,/repayments\/507f1f77bcf86cd799439055\/reverse/);
 assert.match(html,/RECEIPT-REAL/);assert.match(html,/name="_csrf" value="test-csrf"/);
});
test('airtime sale and returned funds render independent corrections, stock and manual delivery warning',async()=>{
 const sale={_id:other,inventoryId:id,createdBy:other,type:'sale',network:'MTN',
  currency:'UGX',phone:'+211912345678',reference:'MTN-PROVIDER-REF',
  retailMinor:'1000',costMinor:'600',profitMinor:'400'};
 const html=await ejs.renderFile(file('airtime/index.ejs'),{...shared,data:{
  summary:[{currency:'UGX',sales:'1000',cost:'600',profit:'400'}],
  records:[sale],corrections:[],inventory:[{network:'MTN',currency:'UGX',costBalanceMinor:'5400'}],
  products:[],funds:[],canManage:true,canSell:true,canCorrect:true,
  branch:{_id:id,currency:'UGX'},activeCurrency:'UGX',currencyChoices:['UGX'],format:fmt,
  saleUuid:'sale-uuid',purchaseUuid:'stock-uuid'
 }});
 assert.match(html,/does not yet send airtime automatically/i);
 assert.match(html,/action="\/tenant\/airtime\/sales"/);
 assert.match(html,/action="\/tenant\/airtime\/stock"/);
 assert.match(html,/action="\/tenant\/airtime\/507f191e810c19729de860ea\/reverse"/);
 assert.match(html,/name="providerReversed" value="yes"/);
 assert.match(html,/name="fundsReturned" value="yes"/);
 assert.match(html,/value="sale-uuid"/);assert.match(html,/value="stock-uuid"/);
});
