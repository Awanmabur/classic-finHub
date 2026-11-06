'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const ejs=require('ejs');
const {Types}=require('mongoose');
const path=require('node:path');
const expense=require('../src/tenant/services/expenses.service');
const reports=require('../src/tenant/services/approvedReports.service');
const schema=require('../src/tenant/models/Expense');
const {currencyCodes}=require('../src/config/currencies');
const id=()=>String(new Types.ObjectId());

test('Expense amounts use exact branch currency scales and bounded fields',()=>{
 const value=expense.values({expenseType:'Transport',amount:'123.45',vendor:'Vendor',reference:'Voucher 1',description:'Notes'},'USD');
 assert.equal(String(value.amountMinor),'12345');
 assert.equal(String(expense.values({expenseType:'Rent',amount:'123',vendor:'',reference:'',description:''},'UGX').amountMinor),'123');
 for(const amount of ['0','-1','1e3','1.001','9007199254740992'])assert.throws(()=>expense.values({expenseType:'Rent',amount},'USD'));
 assert.throws(()=>expense.values({expenseType:'X',amount:'1'},'UGX'));
 assert.deepEqual(schema.path('currency').enumValues,currencyCodes);
});

test('Expense scopes limit operators to their own branch and records',()=>{
 const branch=id(),operator=id();
 const filter=expense.scopeFor({id:operator,branchId:branch,role:'Mobile Money Operator'});
 assert.equal(String(filter.branchId),branch);assert.equal(String(filter.operatorId),operator);
 assert.deepEqual(expense.scopeFor({id:operator,role:'Auditor'}),{});
 const manager=expense.scopeFor({id:operator,role:'Branch Manager',branchId:branch});
 assert.equal(String(manager.branchId),branch);assert(!manager.operatorId);
 assert.throws(()=>expense.scopeFor({id:operator,role:'Viewer'}),{status:403});
});

test('Expense CSV preserves corrections, statuses, exact units and neutralizes formulas',()=>{
 const csv=expense.csv([{createdAt:new Date('2026-11-06T00:00:00Z'),recordReference:'EXP-1',expenseType:'=SUM(1,1)',currency:'USD',
  amountMinor:'12345',paymentMethod:'Cash',vendor:'+123',reference:'@unsafe',description:'"quoted", note',status:'voided',correctionState:'applied'}]);
 assert.match(csv,/'=SUM/);assert.match(csv,/'\+123/);assert.match(csv,/'@unsafe/);assert.match(csv,/"12345"/);assert.match(csv,/"voided"/);assert.match(csv,/""quoted""/);
});

test('Daily report excludes voided mobile fees and pending expenses from totals',()=>{
 const rows=[{module:'Mobile Money',currency:'USD',status:'pending_verification / accepted / none',feesMinor:'123'},
 {module:'Mobile Money',currency:'USD',status:'voided_internal / accepted / voided',feesMinor:'900'},
 {module:'Expenses',currency:'USD',status:'pending_review',amountMinor:'999'},
 {module:'Expenses',currency:'USD',status:'approved',amountMinor:'500'},
 {module:'Expenses',currency:'KES',status:'approved',amountMinor:'100'}];
 const totals=reports.currencyTotals(rows);
 assert.deepEqual(totals.find(row=>row.currency==='USD'),{currency:'USD',recordedFeesMinor:'123',approvedExpensesMinor:'500'});
 assert.equal(totals.find(row=>row.currency==='KES').approvedExpensesMinor,'100');
});

test('Approved reports have all operation report sections and protect invalid scopes',()=>{
 assert.deepEqual(Object.keys(reports.pages),['daily','opening','closing','transactions','expenses','transfer','mobile','banking','forex']);
 const branch=id(),operator=id();
 assert.deepEqual(reports.scopeFor({id:operator,branchId:branch,role:'Reports Analyst'}),{branchId:branch});
 assert.equal(reports.scopeFor({id:operator,branchId:branch,role:'Mobile Money Operator'}).operatorId,operator);
 assert.throws(()=>reports.scopeFor({id:operator,role:'Reports Analyst'}),{status:403});
 assert.equal(String(reports.matchFor({branchId:branch,operatorId:operator},{}).branchId),branch);
});

test('Approved expense modal renders all requested fields, CSRF and no branch selector',async()=>{
 const html=await ejs.renderFile(path.join(__dirname,'../src/views/tenant/expenses/_modal.ejs'),{
  data:{openModal:true,idempotencyKey:crypto.randomUUID()},operationBranch:{name:'Main',currency:'USD'},csrfToken:'csrf',currencyLabel:code=>code});
 for(const label of ['Expense details','Expense type','Currency','Amount','Paid to / vendor','Payment method','Reference','Description','Add expense','Cancel'])assert(html.includes(label),label);
 assert.match(html,/name="_csrf" value="csrf"/);assert.match(html,/action="\/tenant\/expenses"/);
 assert(!html.includes('name="branchId"'));assert(!html.includes('localStorage'));
});

test('An unassigned expense report source performs no database query',async()=>{
 const tenant=require('./helpers/entitlement').entitledTenant({slug:'expense-source-unit',plan:'enterprise',enabledModules:['reports']});
 // This connection has no query methods: any accidental source read fails.
 const conn={name:require('../src/config/tenantDatabaseName').tenantDbNameFromSlug(tenant.slug)};
 const report=await reports.generate(conn,tenant,{id:id(),role:'Tenant Owner',permissions:['*']},'expenses');
 assert.equal(report.sourceAvailable,false);assert.equal(report.expenses,null);assert.equal(report.cash,null);assert.deepEqual(report.rows,[]);
});

test('Approved forex reports render EUR target amounts with their own currency scale',async()=>{
 const format=require('../src/tenant/services/forex.service').amountLabel;
 const html=await ejs.renderFile(path.join(__dirname,'../src/views/tenant/reports/approved.ejs'),{
  data:{canCreateExpense:false,canExport:true,report:{key:'forex',page:reports.pages.forex,filters:{from:'2026-11-06',to:'2026-11-06'},
   scope:{},sourceAvailable:true,cash:null,income:[],impact:{},expenses:null,format,note:'Internal evidence',rows:[{module:'Forex',activity:'USD → EUR quote',
    status:'quoted',currency:'USD',count:1,volume:'USD 10.00',fees:'USD 0.00',targetCurrency:'EUR',targetAmountMinor:'987'}]}},user:{name:'Owner'}});
 assert.match(html,/EUR 9\.87/);assert.match(html,/USD 10\.00/);
});
