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

test('real loan and airtime receipts are linked to scoped immutable records and escape branding',async()=>{
 const fs=require('node:fs');
 const loanView=fs.readFileSync(file('loans/detail.ejs'),'utf8');
 const airView=fs.readFileSync(file('airtime/index.ejs'),'utf8');
 const retail=fs.readFileSync(path.join(__dirname,'../src/tenant/retailFinance/receipts.service.js'),'utf8');
 assert.match(loanView,/repayments\/<%= p\._id %>\/receipt/);
 assert.match(airView,/if\(x\.type==='sale'\)/);
 assert.match(airView,/\/tenant\/airtime\/<%= x\._id %>\/receipt/);
 assert.match(retail,/F\.access\(conn,tenant,actor,'airtime','airtime\.view'\)/);
 assert.match(retail,/F\.scope\(current\.actor\)/);
 const html=await ejs.renderFile(file('retailFinance/acknowledgement.ejs'),{
  identity:{name:'<script>attack()</script>',header:'Branch receipt',template:'Classic',primary:'#082c52',footerNote:'Safe text'},
  receipt:{documentType:'Loan repayment receipt',reference:'LN-REC-123',branch:'North',recordedAt:'22 Nov 2026 10:00',timeZone:'Africa/Juba',
   customer:'Customer',status:'Recorded',reversed:false,
   lines:[['Amount received','SSP 5,000'],['Test','<img src=x onerror=alert(1)>']],
   warning:'Source record is internal',returnUrl:'/tenant/loans/507f191e810c19729de860ea'}
 });
 assert.match(html,/LN-REC-123/);assert.match(html,/SSP 5,000/);
 assert.match(html,/&lt;script&gt;attack\(\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>attack/);
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(html,/<img src=x onerror/);
 assert.match(html,/PROVIDER NOT VERIFIED/);
});
