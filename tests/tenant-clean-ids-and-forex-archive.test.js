'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const src=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const {branchCode,catalogCode,notificationCode}=require('../src/utils/autoIdentifier');
const branches=require('../src/tenant/services/branch.service');
const approvals=require('../src/tenant/services/approvals.service');
const forex=require('../src/tenant/services/forex.service');
const schema=require('../src/tenant/schemas/ForexRate.schema');

test('internal identifiers generate securely and stay within existing schema limits',()=>{
 const first=branchCode('Kampala Main 1'),next=branchCode('Kampala Main 1');
 assert.match(first,/^kampala-main-1-[a-f0-9]{12}$/);
 assert.notEqual(first,next);
 assert(first.length<=32);
 for(const name of ['🇺🇬','1000','_____','Long '.repeat(45)]){
  assert.match(branchCode(name),/^[a-z0-9][a-z0-9-]{1,30}$/);
  assert.match(catalogCode(name),/^[a-z][a-z0-9_]{1,40}$/);
  assert.match(notificationCode(name),/^n_[a-z][a-z0-9_]{1,38}$/);
 }
});
test('new branches require real name, currency and timezone but no typed code',()=>{
 const v=branches.validate({name:'Gulu Branch',currency:'UGX',address:'Gulu'},true);
 assert.match(v.code,/^gulu-branch-[a-f0-9]{12}$/);
 assert.equal(v.name,'Gulu Branch');
 assert.equal(branches.validate({name:'Demo',code:'existing-branch',currency:'USD'},true).code,'existing-branch');
});
test('approval policy IDs are generated when creating new policies, existing codes remain valid for versioning',()=>{
 const input={name:'Daily Expenses',category:'general',steps:['Tenant Owner'],expiresHours:24};
 const v=approvals.policyInput(input);
 assert.match(v.code,/^daily_expenses_[a-f0-9]{10}$/);
 assert.equal(approvals.policyInput({...input,code:'daily_review'}).code,'daily_review');
});
test('new notification templates automatically generate safe codes, existing template versions keep code',()=>{
 const service=require('../src/tenant/services/notification.service');
 const data={name:'System Status',subject:'Daily status',body:'This message is saved securely'};
 const first=service.templateInput(data);
 assert.match(first.code,/^n_system_status_[a-f0-9]{10}$/);
 assert.equal(service.templateInput({...data,code:'daily_status'}).code,'daily_status');
});
test('tenant header separates session actions from branch, currency and search controls',()=>{
 const markup=src('src/views/layouts/dashboard.ejs');
 const start=markup.indexOf('class="tenantHeaderIdentityGroup"');
 const actions=markup.indexOf('class="headerButtons"',start);
 const controls=markup.indexOf('class="tenantHeaderControlGroup"',actions);
 const branch=markup.indexOf('class="ctrl headerBranchView"',start);
 const currency=markup.indexOf('class="headerScope"',start);
 const search=markup.indexOf('class="ctrl headerSearch"',start);
 assert(start>=0&&actions>start&&controls>actions&&branch>controls&&currency>branch&&search>currency);
 const css=src('public/css/dashboard-layout.css');
 assert.match(css,/body\[data-workspace="tenant"\] \.topbar>\.topActions\{\s*display:grid/);
 assert.match(css,/\.tenantHeaderSession\{\s*display:grid;grid-template-columns:minmax\(0,1fr\) auto/);
 assert.match(css,/body\[data-workspace="tenant"\] \.tenantHeaderControlGroup\{\s*display:flex/);
});
test('directory numbers are generated on creation and only unused account numbers can be edited',async()=>{
 const ejs=require('ejs');
 const form=path.join(__dirname,'../src/views/tenant/customer-accounts/form.ejs');
 const render=(formKind,formRecord=null,canCorrectNumber=false)=>ejs.renderFile(form,{
  csrfToken:'fixture',user:{name:'Fixture'},data:{formKind,formRecord,canCorrectNumber,idempotencyKey:'fixture'}
 });
 const customer=await render('customer');
 assert.match(customer,/Customer reference<input[^>]*value="Generated automatically on save" readonly/);
 assert.doesNotMatch(customer,/name="reference"/);
 const created=await render('account');
 assert.match(created,/Account number\s*<input[^>]*value="Generated automatically on save" readonly/);
 assert.doesNotMatch(created,/name="accountNumber"/);
 const account={_id:'example',accountNumber:'ACC-EXAMPLE',currency:'UGX'};
 assert.match(await render('account',account,true),/name="accountNumber" value="ACC-EXAMPLE"[^>]*required/);
 const used=await render('account',account);
 assert.match(used,/value="ACC-EXAMPLE" readonly/);
 assert.doesNotMatch(used,/name="accountNumber"/);
});
test('branch and treasury codes are generated on save',()=>{
 const branch=src('src/views/tenant/branches/index.ejs');
 assert.doesNotMatch(branch,/name="code" required/);
 const treasury=src('src/views/tenant/treasury/index.ejs');
 const quickSetup=src('src/views/tenant/treasury/_owner-setup.ejs');
 const treasuryRoutes=src('src/tenant/treasury/routes.js');
 const treasuryService=src('src/tenant/treasury/service.js');
 // Owners use the Money accounts flow; a manager's advanced form likewise has
 // no editable code field. Codes are generated and checked by the backend.
 assert(treasury.includes("user.role!=='Tenant Owner'"));
 assert.match(quickSetup,/data-quick-account-name/);
 assert.doesNotMatch(treasury,/<input[^>]*name=["']code["']/i);
 assert.doesNotMatch(quickSetup,/<input[^>]*name=["']code["']/i);
 assert(treasuryRoutes.includes("hasOwnProperty.call(req.body||{},'code')"));
 assert(treasuryService.includes('const accountCode=values.code||'));
 assert.match(treasuryService,/code:accountCode/);
});
test('Forex rate board retires only an active immutable price with recorded actor and reason',()=>{
 assert(schema.path('status').enumValues.includes('retired'));
 assert(schema.path('rateDecimal').options.immutable);
 assert(schema.path('retiredBy'));
 assert(schema.path('retiredAt'));
 assert(schema.path('retireNote'));
 assert.equal(typeof forex.retireRate,'function');
 const service=src('src/tenant/services/forex.service.js');
 assert.match(service,/status:'active',\.\.\.branchScope\(actor\)/);
 assert.match(service,/action:'forex\.rate\.retired'/);
 const route=src('src/tenant/routes/forex.routes.js');
 assert.match(route,/router\.post\('\/rates\/:id\/retire'/);
 const view=src('src/views/tenant/forex/index.ejs');
 assert.match(view,/data-replace-forex-rate/);
 assert.match(view,/retiredRates/);
});
test('archiving hides routine directories but retains recovery and owner audit paths',()=>{
 const route=src('src/tenant/routes/index.js');
 assert.match(route,/const showArchived=req\.query\.status==='archived'/);
 const service=src('src/tenant/customerAccounts/service.js');
 assert.match(service,/async function customerRestore/);
 assert.match(service,/customer\.restored/);
 assert.match(service,/status:showClosed\?'closed':\{\$ne:'closed'\}/);
});
