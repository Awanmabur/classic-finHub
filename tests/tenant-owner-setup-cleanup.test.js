'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),ejs=require('ejs');
const source=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
test('Owner sees clean independent currency cards instead of mixed-currency account count',()=>{
 const page=source('src/views/tenant/dashboard/index.ejs');
 assert.doesNotMatch(page,/accounts across currencies/);
 assert.match(page,/data-fund-currency/);
 assert.match(page,/accounts\.filter\(a=>a\.currency===currency\)/);
 assert.match(page,/total\?\.formatted/);
 assert.doesNotThrow(()=>ejs.compile(page));
});
test('Tenant sidebar matches platform account footer with two opposite functional links',()=>{
 const page=source('src/views/partials/dashboard-sidebar.ejs');
 const tenant=page.slice(page.indexOf("if(context==='tenant'){ %>\n  <div class=\"sideFoot"));
 assert.match(tenant,/class="accountActions"/);
 assert.match(tenant,/action="\/logout"/);
 assert.match(tenant,/href="\/"/);
 assert.match(tenant,/> Website<\/a>/);
});
test('Owner can remove eligible accounts while preserving history and restore only unused drafts',async()=>{
 const page=source('src/views/tenant/setup/index.ejs');
 assert.match(page,/\['uninitialized','active'\]\.includes\(a\.status\)/);
 assert.match(page,/String\(a\.bookBalanceMinor\|\|0\)==='0'/);
 assert.match(page,/a\.pendingOpeningId/);
 assert.match(page,/Closed · history retained/);
 assert.match(page,/\/tenant\/treasury\/accounts\/<%= a\._id %>\/remove/);
 assert.match(page,/\/tenant\/treasury\/accounts\/<%= a\._id %>\/restore/);
 assert.match(page,/Confirm remove/);
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
