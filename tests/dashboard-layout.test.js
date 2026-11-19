'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const path=require('node:path');
const {platformMenu}=require('../src/services/menu.service');
const user={id:'admin',name:'Administrator',role:'Super Admin',permissions:['*']};
const defaults={context:'platform',currentPath:'/platform/tenants/create',pageTitle:'Create Tenant',pageSub:'Add a workspace.',tenant:null,user,menu:platformMenu(user),csrfToken:'test',assetVersion:'test',flash:null,money:()=>'',view:'../platform/tenants/create',data:{plans:[],catalogueEmpty:true}};
const render=options=>ejs.renderFile(path.resolve(__dirname,'../src/views/layouts/dashboard.ejs'),{...defaults,...options});

test('creation page has no useless search, duplicate create action or duplicate flash notification',async()=>{
  const html=await render({flash:{type:'good',message:'Unique notification message'}});
  assert.doesNotMatch(html,/id="search"/);
  assert.equal((html.match(/Unique notification message/g)||[]).length,1);
  assert.match(html,/role="status"/);
  const topbar=html.slice(html.indexOf('<div class="topbar">'),html.indexOf('Unique notification message'));
  assert.doesNotMatch(topbar,/href="\/platform\/tenants\/create"/);
  assert.match(html,/action="\/platform\/plans\/publish-initial"/,'the real first-run setup remains available');
});

test('page search appears for loaded records and not for an empty directory',async()=>{
  const options={currentPath:'/platform/tenants',view:'../platform/tenants/index',data:{tenants:[],plans:[]}};
  const empty=await render(options);
  assert.doesNotMatch(empty,/id="search"/);
  const populated=await render({...options,data:{plans:[{code:'agent',name:'Agent Plan'}],tenants:[{id:'123',name:'Acme',slug:'acme',owner:'Owner',email:'owner@example.invalid',plan:'agent',status:'active',setupStatus:'complete',currentPlanName:'Agent Plan',currentPlanVersion:2,planAccessActive:true,currentModuleCount:1,enabledModules:['mobile_money']}]}});
  assert.match(populated,/id="search"/);
  assert.match(populated,/data-search-row/);
  assert.match(populated,/Agent Plan/);
  assert.match(populated,/href="\/platform\/tenants\/123"/);
});

test('nested pages select only their closest navigation entry',async()=>{
  const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/partials/dashboard-sidebar.ejs'),{...defaults,currentPath:'/platform/modules/requests/example'});
  assert.equal((html.match(/aria-current="page"/g)||[]).length,1);
  assert.match(html,/<a href="\/platform\/modules\/requests" class="subitem active" aria-current="page"/);
  assert.doesNotMatch(html,/<a href="\/platform\/modules" class="subitem active"/);
});

test('shared header places controls before the page heading and keeps platform actions together',async()=>{
  const html=await render({currentPath:'/platform/tenants',view:'../platform/tenants/index',data:{tenants:[],plans:[]}});
  const header=html.slice(html.indexOf('<div class="topbar">'),html.indexOf('<section class="view'));
  assert(header.indexOf('class="topActions"')<header.indexOf('class="title"'));
  assert.match(header,/class="headerButtons"><a class="btn btnPrimary" href="\/platform\/tenants\/create"/);
  assert.equal((html.match(/id="menuBtn"/g)||[]).length,1);
  assert.match(html,/href="\/css\/dashboard-layout\.css\?v=test"/);
});

test('tenant header groups branch/currency and receipt/transaction controls without changing their actions',async()=>{
  const paths=['/tenant/dashboard','/tenant/money-transfer','/tenant/last-receipt','/tenant/notifications'];
  const html=await render({context:'tenant',currentPath:'/tenant/dashboard',view:'../tenant/dashboard/index',
    tenant:{slug:'layout-test',name:'Layout test'},menu:[{label:'Overview',items:paths.map(href=>({href,label:href}))}],data:{},
    canViewBranches:true,viewBranchId:'branch-one',viewBranches:[{_id:'branch-one',name:'Main'}],branchViewReturnTo:'/tenant/dashboard'});
  const header=html.slice(html.indexOf('<div class="topbar">'),html.indexOf('<section class="view'));
  assert.match(header,/class="headerIdentity"[\s\S]*class="headerScope" aria-label="Reporting currency"[\s\S]*id="currencySelect"/);
  assert.doesNotMatch(header,/action="\/tenant\/view-branch"/,'Viewing-branch selector moves out of the requested compact header');
  assert.match(html,/class="sidebarBranchView" data-branch-view-form/,'Viewing-branch selector remains operable in sidebar');
  assert.match(html,/action="\/tenant\/view-branch"[\s\S]*name="_csrf" value="test"/);
  assert.match(header,/class="headerPrimaryActions">[\s\S]*id="lastReceiptBtn"[\s\S]*id="newTransactionBtn"/);
  assert.equal((html.match(/id="menuBtn"/g)||[]).length,1);
  assert.equal((html.match(/id="currencySelect"/g)||[]).length,1);
  assert(header.indexOf('class="headerScope"')<header.indexOf('id="pageTitle"'));
});

test('changing header currency preserves report filters and resets pagination',async()=>{
  const html=await render({context:'tenant',currentPath:'/tenant/dashboard',view:'../tenant/dashboard/index',tenant:{slug:'layout-test',name:'Layout test'},menu:[],data:{},
    branchViewReturnTo:'/tenant/dashboard?from=2026-11-01&to=2026-11-08&status=posted&network=MTN&network=Airtel&q=%22%3E%3Cscript%3E&currency=USD&page=3&cursor=old&_csrf=old'});
  const form=html.match(/<form[^>]*data-dashboard-currency-form>([\s\S]*?)<\/form>/)[1];
  for(const [key,value] of [['from','2026-11-01'],['to','2026-11-08'],['status','posted']])assert(form.includes(`name="${key}" value="${value}"`));
  assert.equal((form.match(/name="network"/g)||[]).length,2);
  assert.match(form,/value="USD" selected/);
  assert.match(form,/name="q" value="&#34;&gt;&lt;script&gt;"/);
  assert.doesNotMatch(form,/name="(?:page|cursor|_csrf)"/);
  assert.equal((form.match(/name="currency"/g)||[]).length,1);
});

test('main tenant dashboard presents separately sourced cash and electronic float, not today transaction volume',async()=>{
 const html=await render({context:'tenant',currentPath:'/tenant/dashboard',view:'../tenant/dashboard/index',tenant:{slug:'agent-test',name:'Agent test'},menu:[],data:{
  hasMobileMoney:true,mobileFundsState:'resolved',
  workspaceSnapshot:{todayVolumes:{mobile_money:{formatted:'UGX 900,000'}}},
  mobileFunds:{paymentAccounts:[{kind:'cash',name:'Actual drawer',currency:'UGX',expected:'UGX 70,000',reconciliation:'matched'}],
   wallets:[{kind:'wallet',name:'MTN Uganda network',network:'MTN',currency:'UGX',expected:'UGX 160,000',reconciliation:'matched'}]}
 }});
 const top=html.slice(html.indexOf('Today snapshot'),html.indexOf('Recent activity'));
 for(const label of ['UGX 70,000','UGX 160,000','Actual drawer','MTN Uganda network','Deposits + withdrawals','Physical cash','Electronic float'])assert.ok(top.includes(label),label);
 assert.match(top,/data-dashboard-fund-stat="cash"/);
 assert.match(top,/data-dashboard-fund-stat="float"/);
 assert.doesNotMatch(html,/mobileDashboardBalances/,'no duplicate balances panel below Today snapshot');
 assert.doesNotMatch(html,/Cash-in \+ cash-out/);
});
test('missing dashboard cash and float records are disclosed rather than displayed as fake zero balances',async()=>{
 const html=await render({context:'tenant',currentPath:'/tenant/dashboard',view:'../tenant/dashboard/index',tenant:{slug:'agent-test',name:'Agent test'},menu:[],data:{
  hasMobileMoney:true,mobileFundsState:'branch_required',workspaceSnapshot:{},
  mobileFunds:null
 }});
 assert.match(html,/No operating branch is selected/);
 assert.match(html,/data-dashboard-fund-stat="cash"/);
 assert.match(html,/data-dashboard-fund-stat="float"/);
 assert.doesNotMatch(html,/data-dashboard-fund-stat="(?:cash|float)"[^>]*>[\s\S]*?UGX 0/);
});
