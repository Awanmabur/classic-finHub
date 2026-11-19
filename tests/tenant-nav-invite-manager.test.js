'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const {canSelfReviewRoutine,creatorFilter}=require('../src/tenant/services/reviewPolicy');
const {permissionsFor}=require('../src/config/roles');
const {canDecide}=require('../src/tenant/services/approvals.service');

const owner={id:'owner1',role:'Tenant Owner'};
const manager={id:'mgr1',role:'Branch Manager',branchId:'aaaaaaaaaaaaaaaaaaaaaaaa'};
const operator={id:'operator1',role:'Mobile Money Operator',branchId:'aaaaaaaaaaaaaaaaaaaaaaaa'};
const branch='aaaaaaaaaaaaaaaaaaaaaaaa',other='bbbbbbbbbbbbbbbbbbbbbbbb';
test('only owner and assigned manager can self-review routine operations',()=>{
 assert.equal(canSelfReviewRoutine(owner,branch),true);
 assert.equal(canSelfReviewRoutine(manager,branch),true);
 assert.equal(canSelfReviewRoutine(manager,other),false);
 assert.equal(canSelfReviewRoutine(operator,branch),false);
 assert.equal(canSelfReviewRoutine({role:'Branch Manager',id:'no-branch'},branch),false);
 assert.deepEqual(creatorFilter(owner),{});
 assert.deepEqual(creatorFilter(manager),{});
 assert.deepEqual(creatorFilter(operator),{createdBy:{$ne:operator.id}});
});
test('branch manager gains branch tools, not tenant-wide wildcard or reversal powers',()=>{
 const perms=permissionsFor('Branch Manager');
 for(const right of ['treasury.manage','treasury.review','accounts.manage','mobile_money.review','expenses.review','money_transfer.review','banking.review','forex.rate_review','forex.quotes.review','reports.export','analytics.export'])
  assert(perms.includes(right),'Missing '+right);
 for(const forbidden of ['*','branches.manage','approvals.manage','mobile_money.review_all'])
  assert(!perms.includes(forbidden),'Unexpected '+forbidden);
});
test('internal approval is available to owner or assigned manager without another reviewer role',()=>{
 const request={status:'pending',requesterId:manager.id,branchId:branch,
  expiresAt:new Date('2999-01-01T00:00:00Z'),steps:['Approval Officer'],currentStep:0,decisions:[]};
 assert.equal(canDecide(manager,request),true);
 assert.equal(canDecide(manager,{...request,branchId:other}),false);
 assert.equal(canDecide(owner,request),true);
 assert.equal(canDecide(operator,{...request,requesterId:operator.id}),false);
 assert.equal(canDecide(manager,{...request,status:'approved'}),false);
 assert.equal(canDecide(manager,{...request,expiresAt:new Date('2000-01-01')}),false);
});
test('one-time staff invitation bypasses the global background form interceptor',()=>{
 const js=source('public/js/feedback.js');
 assert.match(js,/action\.pathname==='\/tenant\/users\/invite'/);
 assert.match(source('src/tenant/routes/index.js'),/renderTenant\(req,res,'users\/invite'/);
 assert.match(source('src/tenant/services/staff.service.js'),/tenant\.staff\.invited:/);
});
test('tenant top navigation preserves existing real controls with dedicated responsive groups',()=>{
 const markup=source('src/views/layouts/dashboard.ejs'),css=source('public/css/approved-tenant.css');
 for(const token of ['tenantHeaderIdentityGroup','tenantHeaderControlGroup','headerViewingBranch','currencySelect','headerDriveForm','phase2NotifyBtn','newTransactionBtn','lastReceiptBtn'])
  assert(markup.includes(token),token);
 assert.match(css,/body\[data-workspace="tenant"\] \.tenantHeaderControlGroup/);
 assert.match(css,/@media\(max-width:700px\)/);
});
test('funded self-review cannot bypass reversal, discrepancy and correction restrictions',()=>{
 const treasury=source('src/tenant/treasury/service.js');
 const shifts=source('src/tenant/services/cashDrawer.service.js');
 const momo=source('src/tenant/services/mobileMoney.service.js');
 const expenses=source('src/tenant/services/expenses.service.js');
 assert.match(treasury,/A different person must approve reversal of the original funds entry/);
 assert.match(treasury,/Adjustment approval requires an independent reviewer/);
 assert.match(treasury,/A different authorized person must review a disputed balance/);
 assert.match(shifts,/minor\(result\.varianceMinor\)!==0n/);
 assert.match(momo,/correctionRequestedBy:\{\$ne:reviewer\.id\}/);
 assert.match(expenses,/A different authorized person must decide this correction/);
});
