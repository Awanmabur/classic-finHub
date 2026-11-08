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
  const populated=await render({...options,data:{plans:[{code:'agent',name:'Agent Plan'}],tenants:[{id:'123',name:'Acme',slug:'acme',owner:'Owner',email:'owner@example.invalid',plan:'agent',status:'active',enabledModules:['mobile_money']}]}});
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
  assert.match(header,/class="headerScope">[\s\S]*action="\/tenant\/view-branch"[\s\S]*name="_csrf" value="test"[\s\S]*id="currencySelect"/);
  assert.match(header,/class="headerPrimaryActions">[\s\S]*id="lastReceiptBtn"[\s\S]*id="newTransactionBtn"/);
  assert.equal((html.match(/id="menuBtn"/g)||[]).length,1);
  assert.equal((html.match(/id="currencySelect"/g)||[]).length,1);
  assert(header.indexOf('class="headerScope"')<header.indexOf('id="pageTitle"'));
});
