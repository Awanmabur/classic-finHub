'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const ejs=require('ejs');
const {tenantMenu,tenantNavigationPath}=require('../src/services/menu.service');
const {plans,modules}=require('../src/data/store');
const {asPlanVersion,planSnapshot}=require('../src/platform/services/commercial.service');
const {permissionsFor}=require('../src/config/roles');
const approved={
 Overview:['Today snapshot','New transaction','Last receipt'],
 'Money Transfer':['Send money / Generate PIN','Payout by PIN','Pending payout queue','Money transfer record','Transfer fee summary','Transfer report summary'],
 'Mobile Money':['Cash-in','Cash-out','Network activity','Cash impact','Mobile money report'],
 'Forex Operations':['Buy forex from customer','Sell forex to customer','Active rate board','Forex cash impact','Forex operation records','Forex report summary'],
 'Banking Operations':['Customers directory','New customer','Customer logbook','Accounts directory','New account','Deposit','Withdraw','Account transfer','Account balances','Account movements','Banking report summary'],
 'Operation Reports':['Daily business report','Open day','Close day','Add expense','Export CSV','Print report','General reports page','Opening cash report','Closing cash / expected cash','Transaction summary','Expenses report','Transfer report','Mobile report','Banking report'],
 'Tenant Workspace':['Tenant profile','Landing page setup','Branding & receipts','Branches & locations','Admins, tellers & users','Roles & permissions','Customer/KYC setup','Tenant database','Subscription & limits','Notification rules','Integrations & API','Import / export data','Compliance controls','Landing preview','Receipt preview','Customer portal preview','Tenant audit activity'],
 'Phase 2 Control':['Notifications center','Remote owner dashboard','Teller & staff users','Logs and audit trail','Approvals & corrections','Cash control review','Security & roles','System settings']
};
const branchId='507f1f77bcf86cd799439011',owner={id:branchId,name:'Owner',role:'Tenant Owner',permissions:['*']};
function subscribed(){
 const terms=planSnapshot({...asPlanVersion(plans.find(plan=>plan.code==='enterprise')),status:'published'});
 return {name:'Approved workspace',slug:'approved-workspace',status:'active',plan:'enterprise',
  enabledModules:terms.modules,subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01')},
  moduleGrants:['customers','accounts','expenses'].map(moduleKey=>({moduleKey,status:'granted',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01'),limits:{users:10,branches:3,recordsPerMonth:1000}}))};
}
function actor(role,allowedModules){return {id:branchId,name:'Staff',role,branchId,permissions:permissionsFor(role),allowedModules};}
function paths(menu){return menu.flatMap(group=>group.items.map(item=>item.href));}

test('fully entitled owner receives all eight approved groups and seventy exact ordered labels',()=>{
 const menu=tenantMenu(subscribed(),owner);
 assert.deepEqual(Object.fromEntries(menu.map(group=>[group.label,group.items.map(item=>item.label)])),approved);
 assert.equal(menu.length,8);assert.equal(menu.reduce((sum,group)=>sum+group.items.length,0),70);
 for(const item of menu.flatMap(group=>group.items)){
  assert.match(item.href,/^\/tenant\/[a-z0-9/.-]+$/);
  assert.doesNotMatch(item.href,/javascript:|undefined|#|\?/);
 }
 assert.deepEqual(menu.find(group=>group.label==='Mobile Money').items.map(item=>[item.label,item.href]),[
  ['Cash-in','/tenant/mobile-money/cash-in'],['Cash-out','/tenant/mobile-money/cash-out'],['Network activity','/tenant/mobile-money/network-activity'],['Cash impact','/tenant/mobile-money/cash-impact'],['Mobile money report','/tenant/mobile-money/report']
 ]);
});

test('expanded navigation still requires module entitlement, assignment and fixed permissions',()=>{
 const tenant=subscribed();
 const operator=actor('Mobile Money Operator',['mobile_money']);
 const menu=tenantMenu(tenant,operator),operatorPaths=paths(menu);
 assert(menu.some(group=>group.label==='Mobile Money'&&group.items.length===5));
 assert(operatorPaths.includes('/tenant/mobile-money/report'));
 for(const forbidden of ['/tenant/workspace','/tenant/workspace/profile','/tenant/workspace/subscription','/tenant/users','/tenant/branches','/tenant/expenses/new','/tenant/customers/new','/tenant/reports','/tenant/approvals'])
  assert(!operatorPaths.includes(forbidden),`Unassigned or privileged path exposed: ${forbidden}`);
 assert(!tenantMenu(tenant,{...operator,allowedModules:[]}).some(group=>group.label==='Mobile Money'));
 const viewer=actor('Viewer',['mobile_money']);
 const viewerMobile=tenantMenu(tenant,viewer).find(group=>group.label==='Mobile Money');
 assert(viewerMobile);assert(!viewerMobile.items.some(item=>item.transactionKind),'Read-only links cannot launch a financial form');
 assert(!paths(tenantMenu(tenant,viewer)).includes('/tenant/mobile-money/report'));
 const analyst=actor('Reports Analyst',['reports']);
 assert(paths(tenantMenu(tenant,analyst)).includes('/tenant/reports/daily'));
 assert(!tenantMenu(tenant,analyst).some(group=>['Money Transfer','Mobile Money','Forex Operations','Banking Operations'].includes(group.label)));
 const withoutGrants={...tenant,moduleGrants:[]};
 assert(!paths(tenantMenu(withoutGrants,owner)).includes('/tenant/customers'));
 assert(!paths(tenantMenu(withoutGrants,owner)).includes('/tenant/accounts'));
 assert(!paths(tenantMenu(withoutGrants,owner)).includes('/tenant/expenses/new'));
 assert(!modules.find(module=>module.key==='customer_portal').runtimeStatus.includes('enabled'));
});

test('duplicate destination links produce exactly one active sidebar entry on each approved page',async()=>{
 const tenant=subscribed(),menu=tenantMenu(tenant,owner);
 const destinations=new Set([...paths(menu),'/tenant/mobile-money/shifts/507f1f77bcf86cd799439012','/tenant/customers/507f1f77bcf86cd799439013']);
 const template=path.join(__dirname,'../src/views/partials/dashboard-sidebar.ejs');
 for(const currentPath of destinations){
  const html=await ejs.renderFile(template,{context:'tenant',menu,currentPath:tenantNavigationPath(currentPath),tenant,user:owner,csrfToken:'test'});
  assert.equal((html.match(/aria-current="page"/g)||[]).length,1,`Exactly one active entry required for ${currentPath}`);
  assert.equal((html.match(/class="subitem active"/g)||[]).length,1,`Exactly one selected style required for ${currentPath}`);
 }
});

test('base catalogue versions keep their original module terms when new independent modules are introduced',()=>{
 const enterprise=asPlanVersion(plans.find(plan=>plan.code==='enterprise'));
 for(const key of ['customers','accounts','expenses','sms_capture'])assert(!enterprise.modules.includes(key),`Existing catalogue terms must not silently gain ${key}`);
 assert(enterprise.modules.includes('mobile_money'));assert(enterprise.modules.includes('reports'));
});


test('legacy history, contact and detail links keep the corresponding approved module group selected',()=>{
 const {tenantNavigationPath}=require('../src/services/menu.service');
 assert.equal(tenantNavigationPath('/tenant/mobile-money/history'),'/tenant/mobile-money/network-activity');
 assert.equal(tenantNavigationPath('/tenant/money-transfer/507f1f77bcf86cd799439012'),'/tenant/money-transfer/records');
 assert.equal(tenantNavigationPath('/tenant/money-transfer/contacts'),'/tenant/money-transfer/send');
 assert.equal(tenantNavigationPath('/tenant/forex/history'),'/tenant/forex/records');
 assert.equal(tenantNavigationPath('/tenant/mobile-money/shifts'),'/tenant/cash/shifts');
 assert.equal(tenantNavigationPath('/tenant/mobile-money/shifts/507f1f77bcf86cd799439012'),'/tenant/cash/shifts/507f1f77bcf86cd799439012');
 for(const path of ['/tenant/mobile-money/cash-in','/tenant/money-transfer/fees','/tenant/forex/rates','/tenant/forex/buy'])assert.equal(tenantNavigationPath(path),path);
});
