'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const path=require('node:path');
const template=path.resolve(__dirname,'../src/views/layouts/dashboard.ejs');
const roles=require('../src/config/roles');
const fixture=dashboardCurrency=>({
 context:'tenant',currentPath:'/tenant/dashboard',pageTitle:'Overview',pageSub:'Daily financial operations',
 tenant:{name:'Nile Exchange & Services',slug:'nile-exchange',status:'active'},
 user:{name:'Grace Operator',role:'Tenant Owner',permissions:roles.permissionsFor('Tenant Owner')},
 menu:[{label:'Tenant Workspace',items:[{label:'Overview',href:'/tenant/dashboard'}]}],
 operationBranch:{_id:'507f1f77bcf86cd799439011',name:'Juba West',currency:'SSP'},
 csrfToken:'test-csrf',assetVersion:'tests',flash:null,money:()=>'',amountFromMinor:()=>'',view:'../tenant/dashboard/index',
 data:{dashboardCurrency,hasMobileMoney:false,hasTransfer:true,hasBanking:false,hasForex:false,
  workspaceSnapshot:{todayVolumes:{money_transfer:{formatted:'UGX 500'}},
   todayByCurrency:{money_transfer:[{currency:'UGX',count:2,formatted:'UGX 2,000'},{currency:'USD',count:3,formatted:'USD 11.00'}]}},
  financeOverview:{available:false}}
});
test('Every tenant dashboard uses its own brand, with website/logout and operator in top navigation',async()=>{
 const html=await ejs.renderFile(template,fixture(''));
 assert.match(html,/<title>Overview — Nile Exchange &amp; Services<\/title>/);
 assert.match(html,/<h1>Nile Exchange &amp; Services<\/h1>/);
 assert.match(html,/tenantBrandInitials/);
 assert.doesNotMatch(html,/<h1>ClassicFin Hub<\/h1>/);
 assert.match(html,/class="headerIdentity"/);
 assert.match(html,/Grace Operator/);
 assert.match(html,/Juba West · Tenant Owner/);
 assert.match(html,/data-operating-branch data-branch-name="Juba West" data-branch-currency="SSP"/);
 assert.match(html,/aria-label="Visit website"/);
 assert.match(html,/<form method="post" action="\/logout"><input type="hidden" name="_csrf" value="test-csrf"/);
 assert.equal((html.match(/action="\/logout"/g)||[]).length,1,'One visible tenant signout action');
 assert.match(html,/name="currency" aria-label="Display currency"><option value="" selected>All currencies/);
});
test('Default overview counts all transactions but never adds unlike currencies, then filters on selection',async()=>{
 const all=await ejs.renderFile(template,fixture(''));
 assert.match(all,/class="v" id="ovTransfer">5 transactions<\/div>/);
 assert.match(all,/UGX 2,000/);assert.match(all,/USD 11.00/);
 const usd=await ejs.renderFile(template,fixture('USD'));
 assert.match(usd,/value="USD" selected/);
 assert.match(usd,/class="v" id="ovTransfer">USD 11.00<\/div>/);
 assert.doesNotMatch(usd,/UGX 2,000/,'Selected USD stats must not show UGX volumes');
 assert.match(usd,/USD 11.00/);
});
