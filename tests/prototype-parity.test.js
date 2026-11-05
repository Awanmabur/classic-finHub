'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const load=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('prototype-style dashboard includes permission-filtered real action chooser',()=>{
  const layout=load('src/views/layouts/dashboard.ejs');
  assert.match(layout,/context === 'tenant' && quickActions\.length/);
  assert.match(layout,/id="operationChooser"/);
  assert.match(layout,/id="newTransactionBtn"/);
  assert.match(layout,/action\.href/);
  assert.doesNotMatch(layout,/localStorage|seedDemo/);
});

test('secure modal forms retain original POST targets and safety controls',()=>{
  const modules=[
    ['src/views/tenant/money-transfer/index.ejs','/tenant/money-transfer/requests'],
    ['src/views/tenant/mobile-money/index.ejs','/tenant/mobile-money/cash-in'],
    ['src/views/tenant/banking/index.ejs','/tenant/banking/requests'],
    ['src/views/tenant/forex/index.ejs','/tenant/forex/rates'],
    ['src/views/tenant/forex/index.ejs','/tenant/forex/quotes']
  ];
  for(const [file,target] of modules){
    const html=load(file);
    assert.match(html,/data-operation-form=/,file);
    assert(html.includes('action="'+target+'"'),target);
    assert(html.includes('name="_csrf"'),file);
  }
  const js=load('public/js/dashboard.js');
  assert.match(js,/parent\.replaceChild\(launcher,form\)/);
  assert.match(js,/sheetBody\.appendChild\(form\)/);
  assert.match(js,/attachDialog/);
  assert.doesNotMatch(js,/fetch\(.+\/tenant\/.*\/requests/);
});

test('module nav links only to actual implemented tenant route groups',()=>{
  const source=load('src/services/menu.service.js');
  for(const route of ['/tenant/money-transfer/history','/tenant/mobile-money/shifts','/tenant/banking/accounts','/tenant/forex/history'])
    assert(source.includes(route),route);
  assert.doesNotMatch(source,/\/tenant\/customers['"]/);
  assert.doesNotMatch(source,/\/tenant\/receipts['"]/);
  assert.match(source,/hasModuleForUser/);
  assert.match(source,/hasPermission/);
});


test('additional staff and operational modules use their original secured POST forms',()=>{
  for(const [file,action] of [
    ['src/views/tenant/approvals/index.ejs','/tenant/approvals/requests'],
    ['src/views/tenant/users/index.ejs','/tenant/users/invite'],
    ['src/views/tenant/branches/index.ejs','/tenant/branches'],
    ['src/views/tenant/notifications/index.ejs','/tenant/notifications/send'],
    ['src/views/tenant/notifications/index.ejs','/tenant/notifications/templates']
  ]){
    const source=load(file);
    assert(source.includes('action="'+action+'"'),action);
    assert(source.includes('data-operation-form='),file);
    assert(source.includes('name="_csrf"'),file);
  }
  const sidebar=load('src/views/partials/dashboard-sidebar.ejs');
  assert.match(sidebar,/data-open-operation-chooser/);
  const routes=load('src/tenant/routes/index.js');
  assert.match(routes,/currentPath:req\.baseUrl \+ req\.path/);
});
