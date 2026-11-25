'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),ejs=require('ejs');
const source=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
test('Owner sees separate native amounts for cash and float in compact stats',()=>{
 const file=path.join(__dirname,'../src/views/tenant/dashboard/index.ejs');
 const html=ejs.render(source('src/views/tenant/dashboard/index.ejs'),{data:{mobileBookTotals:{
  cash:[{currency:'SSP',formatted:'SSP 75.00'}],
  float:[{currency:'USD',formatted:'USD 25.00'},{currency:'UGX',formatted:'UGX 35,000'}]
 }}},{filename:file});
 assert.match(html,/data-dashboard-fund-stat="cash"[\s\S]*SSP 75\.00/);
 assert.match(html,/data-dashboard-fund-stat="float"[\s\S]*USD 25\.00[\s\S]*UGX 35,000/);
 assert.doesNotMatch(html,/accounts across currencies/);
});
test('Tenant sidebar matches platform account footer with two opposite functional links',()=>{
 const page=source('src/views/partials/dashboard-sidebar.ejs');
 const tenant=page.slice(page.indexOf("if(context==='tenant'){ %>\n  <div class=\"sideFoot"));
 assert.match(tenant,/class="accountActions"/);
 assert.match(tenant,/action="\/logout"/);
 assert.match(tenant,/href="\/"/);
 assert.match(tenant,/> Website<\/a>/);
});
test('Money accounts archive only unused owner accounts and can restore without deleting records',async()=>{
 const page=source('src/views/tenant/treasury/_owner-account-settings.ejs');
 assert.match(page,/account\.status==='uninitialized'/);
 assert.match(page,/account\.openingBalanceMinor===null/);
 assert.match(page,/account\.pendingOpeningId/);
 assert.match(page,/<%= path %>\/archive/);
 const accounts=source('src/views/tenant/treasury/_owner-money.ejs');
 assert.match(accounts,/account\.sequence/);
 assert.match(accounts,/\/tenant\/treasury\/accounts\/<%= account\._id %>\/restore/);
 assert.match(page,/name="confirmCode"/);
 assert.match(page,/name="_csrf"/);
 assert.doesNotThrow(()=>ejs.compile(page));
 const routes=source('src/tenant/treasury/routes.js');
 assert.match(routes,/treasury\.archiveUnusedAccount/);
 assert.match(routes,/treasury\.restoreArchivedAccount/);
 const svc=require('../src/tenant/treasury/service');
 assert.equal(typeof svc.archiveUnusedAccount,'function');
 assert.equal(typeof svc.restoreArchivedAccount,'function');
});
test('Setup integrity checks are bounded and remain mandatory',()=>{
 const routes=source('src/tenant/setup/routes.js');
 assert.match(routes,/for\(let i=0;i<verified\.length;i\+=4\)/);
 assert.match(routes,/Promise\.all\(verified\.slice\(i,i\+4\)\.map/);
 assert.match(routes,/treasury\.assertBookIntegrity/);
 assert.match(routes,/integrityBlocked=true/);
});
