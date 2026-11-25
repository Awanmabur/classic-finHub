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
test('Tenant dashboard uses its own brand and puts account, Logout and Website in the sidebar footer',async()=>{
 const html=await ejs.renderFile(template,fixture(''));
 assert.match(html,/<title>Overview — Nile Exchange &amp; Services<\/title>/);
 assert.match(html,/<h1>Nile Exchange &amp; Services<\/h1>/);
 assert.match(html,/tenantBrandInitials/);
 assert.doesNotMatch(html,/<h1>ClassicFin Hub<\/h1>/);
 assert.match(html,/class="headerIdentity"/);
 assert.match(html,/Grace Operator/);
 assert.match(html,/Juba West · Tenant Owner/);
 assert.match(html,/data-operating-branch data-branch-name="Juba West" data-branch-currency="SSP"/);
 assert.doesNotMatch(html,/aria-label="Visit website"/);
 const sidebar=html.slice(html.indexOf('<aside class="panel side"'),html.indexOf('</aside>'));
 const header=html.slice(html.indexOf('<div class="topbar">'),html.indexOf('<div class="title">'));
 assert.match(sidebar,/class="sidebarLogoutForm"/);
 assert.doesNotMatch(sidebar,/class="sidebarBackupForm"/,'Backup icon moved to header');
 assert.match(header,/class="headerDriveForm"/,'Owner backup icon remains available');
 assert.match(sidebar,/<form method="post" action="\/logout" class="sidebarLogoutForm">/);
 assert.match(sidebar,/name="_csrf" value="test-csrf"/);
 assert.equal((html.match(/action="\/logout"/g)||[]).length,1);
 assert.doesNotMatch(header,/action="\/logout"/);
 const footer=sidebar.slice(sidebar.indexOf('class="sideFoot tenantSideFoot"'));
 assert.match(footer,/<b>Grace Operator<\/b><span>Tenant Owner<\/span>[\s\S]*class="sidebarLogoutForm"[\s\S]*Logout[\s\S]*href="\/"[^>]*>[\s\S]*Website/);
 assert.doesNotMatch(footer,/Connected|Pending sync/);
 assert.match(html,/name="currency" aria-label="Display currency"><option value="" selected>All currencies/);
});
test('Tenant header orders identity, branch, currency, search and actions without duplicates',async()=>{
 const args=fixture('');
 args.menu[0].items.push({label:'Notifications',href:'/tenant/notifications'},
  {label:'Last receipt',href:'/tenant/last-receipt'},
  {label:'Money Transfer',href:'/tenant/money-transfer'});
 args.canViewBranches=true;
 args.viewBranches=[{_id:'507f1f77bcf86cd799439011',name:'Juba West'}];
 args.viewBranchId='all';
 args.branchViewReturnTo='/tenant/dashboard';
 args.data.workspaceSnapshot.recentActivity=[{
  kind:'money-transfer',label:'Posted transfer',href:'/tenant/money-transfer/507f1f77bcf86cd799439011'
 }];
 const html=await ejs.renderFile(template,args);
 const header=html.slice(html.indexOf('<div class="topbar">'),html.indexOf('<div class="title">'));
 const positions=['class="headerIdentity"','id="menuBtn"','class="ctrl headerBranchView"','class="headerScope"',
  'class="ctrl headerSearch"','id="phase2NotifyBtn"','class="headerDriveForm"','id="lastReceiptBtn"','id="newTransactionBtn"'].map(token=>header.indexOf(token));
 assert(positions.every(index=>index>=0),JSON.stringify(positions));
 assert(positions.every((index,i)=>i===0||index>positions[i-1]),'Header action order must match cashier workflow');
 assert.doesNotMatch(header,/Visit website|action="\/logout"/);
 assert.match(header,/class="ctrl headerBranchView" data-branch-view-form/);
 assert.match(header,/class="headerDriveForm"/);
 assert.doesNotMatch(html,/class="sidebarBranchView"/,'Do not duplicate authorized branch selector');
 assert.match(html,/action="\/tenant\/view-branch"/);
 assert.match(html,/name="viewBranchId" aria-label="Viewing branch"/);
 assert.match(header,/id="lastReceiptBtn"[^>]+aria-label="Last receipt"/);
});
test('Default overview shows every currency separately and supports explicit selection',async()=>{
 const all=await ejs.renderFile(template,fixture(''));
 const allRows=all.match(/<table data-dashboard-currency-stats>[\s\S]*?<\/table>/)?.[0];
 assert(allRows);
 assert.deepEqual([...allRows.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map(match=>match[1]),['UGX','USD','SSP','KSH']);
 assert.match(allRows,/UGX 2,000<small>2 transactions/);
 assert.match(allRows,/USD 11\.00<small>3 transactions/);
 assert.doesNotMatch(allRows,/UGX 500|5 transactions/);
 const usd=await ejs.renderFile(template,fixture('USD'));
 assert.match(usd,/value="USD" selected/);
 const selected=usd.match(/<table data-dashboard-currency-stats>[\s\S]*?<\/table>/)?.[0];
 assert(selected);
 assert.deepEqual([...selected.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map(match=>match[1]),['USD']);
 assert.match(selected,/USD 11\.00/);
 assert.doesNotMatch(selected,/UGX 2,000/);
});

test('Forex records reuse a single approved dashboard stat grid instead of generating duplicate cards',async()=>{
 const data={moduleKey:'forex',label:'Forex',basePath:'/tenant/forex',title:'Forex operation records',mode:'records',total:2,
  currencies:['UGX','USD','SSP','KES'],filters:{from:'2026-11-01',to:'2026-11-19',status:'',kind:'',currency:''},
  records:{items:[],nextCursor:null},rows:[],canExport:false,note:'Posted records retain their original currencies',
  stats:{total:2,posted:1,pending:1,collected:0,stopped:0,completedLabel:'Posted exchanges',
   postedVolumes:[{currency:'UGX',formatted:'UGX 10,000'}],
   targetVolumes:[{currency:'SSP',formatted:'SSP 8,000.00'}]},
  financeOverview:{available:true,moduleEarnings:[],byModule:[]}};
 const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/tenant/forex/workspace.ejs'),{
  data,user:{name:'Owner',role:'Tenant Owner',permissions:['*']},businessTimeZone:'Africa/Juba',
  currencyLabel:currency=>currency==='KES'?'KSH':currency
 });
 assert.equal((html.match(/class="grid3 overviewStatsGrid moduleStatsGrid"/g)||[]).length,1);
 assert.doesNotMatch(html,/class="moduleRecordStats"/,'The second duplicate stats section must not be recreated');
 assert.match(html,/Transactions in selected period/);
 assert.match(html,/Posted exchanges/);
 assert.match(html,/UGX 10,000/);
 assert.match(html,/SSP 8,000.00/);
});
