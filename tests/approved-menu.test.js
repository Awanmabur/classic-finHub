'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const ejs=require('ejs');
const {tenantMenu,tenantNavigationPath}=require('../src/services/menu.service');
const {plans,modules}=require('../src/data/store');
const {asPlanVersion,planSnapshot}=require('../src/platform/services/commercial.service');
const {permissionsFor}=require('../src/config/roles');
const branchId='507f1f77bcf86cd799439011',owner={id:branchId,name:'Owner',role:'Tenant Owner',permissions:['*']};
function subscribed(){
 const terms=planSnapshot({...asPlanVersion(plans.find(plan=>plan.code==='enterprise')),status:'published'});
 return {name:'Approved workspace',slug:'approved-workspace',status:'active',plan:'enterprise',
  enabledModules:terms.modules,subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01')},
  moduleGrants:['customers','accounts','expenses','loans','airtime'].map(moduleKey=>({moduleKey,status:'granted',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01'),limits:{users:10,branches:3,recordsPerMonth:1000}}))};
}
function actor(role,allowedModules){return {id:branchId,name:'Staff',role,branchId,permissions:permissionsFor(role),allowedModules};}
function paths(menu){return menu.flatMap(group=>group.items.map(item=>item.href));}
function reportPaths(menu){return menu.find(group=>group.label==='Operation Reports')?.paths||[];}

test('fully entitled owner can reach Money accounts and Cash day directly',()=>{
 const menu=tenantMenu(subscribed(),owner),links=paths(menu);
 const work=menu.find(group=>group.label==='Daily work').items;
 assert.deepEqual(work.map(item=>[item.label,item.href]),[
  ['Cash day','/tenant/cash/shifts'],['Money accounts','/tenant/treasury'],['Expenses','/tenant/expenses']
 ]);
 for(const link of ['/tenant/dashboard','/tenant/treasury','/tenant/cash/shifts','/tenant/customers','/tenant/accounts','/tenant/reports','/tenant/users','/tenant/workspace','/tenant/audit','/tenant/setup','/tenant/modules','/tenant/workspace/reviews']){
  assert.equal(links.filter(path=>path===link).length,1,link+' is linked once');
 }
 for(const removed of ['/tenant/funded','/tenant/approvals','/tenant/day/close','/tenant/accounts/balances','/tenant/accounts/movements','/tenant/reports/export.csv','/tenant/reports/opening','/tenant/reports/closing','/tenant/transactions/new','/tenant/last-receipt']){
  assert(!links.includes(removed),removed+' is handled within its workflow');
 }
 for(const link of links)assert.match(link,/^\/tenant\/[a-z0-9/.-]+(?:#[a-z0-9-]+)?$/);
 assert(links.includes('/tenant/funded/payout'));
 assert(links.includes('/tenant/loans#loan-applications'));
 assert.equal(links.filter(link=>link==='/tenant/loans').length,1);
 assert(links.length<45);
});

test('only active subscribed and assigned source modules appear in navigation and report links',()=>{
 const base=subscribed(),expired={...base,enabledModules:[],moduleGrants:[],subscription:{...base.subscription,periodEnd:new Date('2020-01-01')}};
 const none=paths(tenantMenu(expired,owner));
 for(const forbidden of ['/tenant/treasury','/tenant/funded','/tenant/transactions/new','/tenant/last-receipt','/tenant/analytics','/tenant/workspace/control','/tenant/workspace/customer-portal-preview','/tenant/reports/mobile','/tenant/reports/banking'])assert(!none.includes(forbidden),`Unsubscribed operation shown: ${forbidden}`);
 const grant=moduleKey=>({moduleKey,status:'granted',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01'),limits:{users:10,branches:3,recordsPerMonth:1000}});
 const bankingOnly={...expired,moduleGrants:[grant('reports'),grant('banking'),{...grant('forex'),status:'revoked'},{...grant('mobile_money'),periodEnd:new Date('2020-01-01')},{...grant('money_transfer'),periodStart:new Date('2030-01-01'),periodEnd:new Date('2031-01-01')}]};
 const bankingPaths=paths(tenantMenu(bankingOnly,owner));
 for(const expected of ['/tenant/banking/deposit','/tenant/reports','/tenant/treasury'])assert(bankingPaths.includes(expected),expected);
 const bankingReports=reportPaths(tenantMenu(bankingOnly,owner));
 for(const expected of ['/tenant/reports/banking','/tenant/reports/opening','/tenant/reports/closing'])assert(bankingReports.includes(expected),expected);
 for(const hidden of ['/tenant/reports/mobile','/tenant/reports/transfer','/tenant/reports/expenses'])assert(!bankingReports.includes(hidden),hidden);
 for(const forbidden of ['/tenant/mobile-money/cash-in','/tenant/forex/buy','/tenant/money-transfer/send','/tenant/reports/mobile','/tenant/reports/transfer','/tenant/reports/expenses','/tenant/last-receipt'])assert(!bankingPaths.includes(forbidden),forbidden);
 const analyst=actor('Reports Analyst',['reports']);
 const reportsOnly=[...paths(tenantMenu(bankingOnly,analyst)),...reportPaths(tenantMenu(bankingOnly,analyst))];
 for(const forbidden of ['/tenant/reports/opening','/tenant/reports/closing','/tenant/reports/banking','/tenant/reports/transactions','/tenant/treasury','/tenant/funded','/tenant/transactions/new'])assert(!reportsOnly.includes(forbidden),`Unassigned source shown: ${forbidden}`);
 const analystWithSource=tenantMenu(bankingOnly,{...analyst,allowedModules:['reports','banking']});
 const readSource=paths(analystWithSource),readReports=reportPaths(analystWithSource);
 assert(readReports.includes('/tenant/reports/banking'));assert(readReports.includes('/tenant/reports/opening'));
 assert(!readSource.includes('/tenant/treasury'),'Report source access does not grant wallet administration');
 assert(!readSource.includes('/tenant/banking/deposit'),'Report source access does not grant banking execution');
 const operator=actor('Banking Operator',['banking']);
 assert(paths(tenantMenu(bankingOnly,operator)).includes('/tenant/treasury'));
 assert(!paths(tenantMenu(bankingOnly,{...operator,permissions:operator.permissions.filter(permission=>permission!=='treasury.view')})).includes('/tenant/treasury'));
 assert(!paths(tenantMenu({...bankingOnly,status:'suspended'},owner)).includes('/tenant/treasury'));
});

test('rendered topbar hides receipt and transaction actions when no subscribed source can serve them',async()=>{
 const template=path.join(__dirname,'../src/views/layouts/dashboard.ejs');
 const render=async tenant=>ejs.renderFile(template,{
  context:'tenant',currentPath:'/tenant/dashboard',pageTitle:'Overview',pageSub:'Workspace activity',tenant,user:owner,menu:tenantMenu(tenant,owner),
  csrfToken:'test-csrf',assetVersion:'test',flash:null,money:()=>'',amountFromMinor:()=>'',operationBranch:null,
  view:'../tenant/dashboard/index',data:{hasMobileMoney:false,hasBanking:false,hasForex:false,hasTransfer:false,workspaceSnapshot:{cash:[],recentActivity:[]}}
 });
 const base=subscribed(),reportsOnly={...base,enabledModules:['reports'],moduleGrants:[]};
 const reportHtml=await render(reportsOnly);
 assert.doesNotMatch(reportHtml,/id="lastReceiptBtn"|id="newTransactionBtn"|data-operation-dialog/);
 assert.doesNotMatch(reportHtml,/href="\/tenant\/cash\/shifts"/,'A report subscription alone does not expose cash controls');
 const bankingHtml=await render({...base,enabledModules:['banking'],moduleGrants:[]});
 assert.doesNotMatch(bankingHtml,/id="lastReceiptBtn"/,'Banking instructions do not supply the Mobile/Transfer receipt page');
 assert.match(bankingHtml,/id="newTransactionBtn"/);
 assert.match(bankingHtml,/href="\/tenant\/cash\/shifts"/,'A subscribed banking source supplies the Cash Day page');
 assert.doesNotMatch(bankingHtml,/href="\/tenant\/(?:funded|approvals)"/);
 assert.doesNotMatch(bankingHtml,/data-transaction-kind="approval"/);
 const mobileHtml=await render({...base,enabledModules:['mobile_money'],moduleGrants:[]});
 assert.match(mobileHtml,/id="lastReceiptBtn"/);
 assert.match(mobileHtml,/data-transaction-kind="cash_in"/);
});

test('consolidated navigation still requires module entitlement, assignment and fixed permissions',()=>{
 const tenant=subscribed();
 const operator=actor('Mobile Money Operator',['mobile_money']);
 const menu=tenantMenu(tenant,operator),operatorPaths=paths(menu);
 assert(menu.some(group=>group.label==='Mobile Money'&&group.items.length===3));
 assert(operatorPaths.includes('/tenant/mobile-money/network-activity'));
 assert(!operatorPaths.includes('/tenant/mobile-money/onboarding'));
 assert(!operatorPaths.includes('/tenant/mobile-money/fx'),'Cross-currency requires Forex module assignment');
 const fxOperator=actor('Mobile Money Operator',['mobile_money','forex']);
 assert(!paths(tenantMenu(tenant,fxOperator)).includes('/tenant/mobile-money/fx'),'Exchange is embedded in existing cashier forms, not a sidebar destination');
 for(const forbidden of ['/tenant/workspace','/tenant/workspace/profile','/tenant/workspace/subscription','/tenant/users','/tenant/branches','/tenant/expenses/new','/tenant/customers/new','/tenant/reports','/tenant/approvals'])
  assert(!operatorPaths.includes(forbidden),`Unassigned or privileged path exposed: ${forbidden}`);
 assert(operatorPaths.includes('/tenant/cash/shifts'));
 assert(operatorPaths.includes('/tenant/treasury'));
 assert(!tenantMenu(tenant,{...operator,allowedModules:[]}).some(group=>group.label==='Mobile Money'));
 const managerPaths=paths(tenantMenu(tenant,actor('Branch Manager',['banking','approval_workflows'])));
 assert(managerPaths.includes('/tenant/funded'));
 assert(managerPaths.includes('/tenant/approvals'));
 const viewer=actor('Viewer',['mobile_money']);
 const viewerMobile=tenantMenu(tenant,viewer).find(group=>group.label==='Mobile Money');
 assert(viewerMobile);assert(!viewerMobile.items.some(item=>item.transactionKind),'Read-only links cannot launch a financial form');
 assert(!paths(tenantMenu(tenant,viewer)).includes('/tenant/mobile-money/report'));
 const analyst=actor('Reports Analyst',['reports']);
 assert(paths(tenantMenu(tenant,analyst)).includes('/tenant/reports'));
 assert(reportPaths(tenantMenu(tenant,analyst)).includes('/tenant/reports/daily'));
 assert(!tenantMenu(tenant,analyst).some(group=>['Money Transfer','Mobile Money','Forex Operations','Banking Operations'].includes(group.label)));
 const withoutGrants={...tenant,moduleGrants:[]};
 assert(!paths(tenantMenu(withoutGrants,owner)).includes('/tenant/customers'));
 assert(!paths(tenantMenu(withoutGrants,owner)).includes('/tenant/accounts'));
 assert(!paths(tenantMenu(withoutGrants,owner)).includes('/tenant/expenses/new'));
 assert(!modules.find(module=>module.key==='customer_portal').runtimeStatus.includes('enabled'));
});

test('duplicate destination links produce exactly one active sidebar entry on each approved page',async()=>{
 const tenant=subscribed(),menu=tenantMenu(tenant,owner);
 const destinations=new Set([...paths(menu),'/tenant/customers/507f1f77bcf86cd799439013']);
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

test('assigned view-only modules never advertise cashier-only entry screens',()=>{
 const tenant=subscribed();
 const viewer=actor('Viewer',['mobile_money']);
 const viewerPaths=paths(tenantMenu(tenant,viewer));
 assert(viewerPaths.includes('/tenant/mobile-money/network-activity'));
 assert(!viewerPaths.includes('/tenant/mobile-money/cash-in'));
 assert(!viewerPaths.includes('/tenant/mobile-money/cash-out'));
 const auditor=actor('Auditor',['forex','money_transfer','banking']);
 const auditPaths=paths(tenantMenu(tenant,auditor));
 for(const forbidden of ['/tenant/forex/buy','/tenant/forex/sell','/tenant/money-transfer/send',
  '/tenant/banking/deposit','/tenant/banking/withdraw','/tenant/banking/transfer'])
  assert(!auditPaths.includes(forbidden),forbidden);
 assert(auditPaths.includes('/tenant/forex/rates'));
 assert(auditPaths.includes('/tenant/money-transfer/records'));
});

test('tenant owner keeps module requests and accesses role assignments from settings',()=>{
 const ownerItems=tenantMenu(subscribed(),owner).flatMap(group=>group.items);
 assert.equal(ownerItems.find(item=>item.label==='Request modules')?.href,'/tenant/modules');
 assert.equal(ownerItems.find(item=>item.label==='Settings')?.href,'/tenant/workspace');
 const member=actor('Mobile Money Operator',['mobile_money']);
 assert(!paths(tenantMenu(subscribed(),member)).includes('/tenant/modules'));
 const workspace=require('fs').readFileSync(path.resolve(__dirname,'../src/views/tenant/workspace/index.ejs'),'utf8');
 assert.match(workspace,/href="\/tenant\/modules">Request modules/);
 assert.match(workspace,/href="\/tenant\/workspace\/roles"/);
 const routes=require('fs').readFileSync(path.resolve(__dirname,'../src/tenant/workspace/routes.js'),'utf8');
 assert.match(routes,/renderTenant\(req,res,'workspace\/role-access'/);
 const users=require('fs').readFileSync(path.resolve(__dirname,'../src/views/tenant/users/index.ejs'),'utf8');
 assert.match(users,/id="role-module-assignments"/);
});
