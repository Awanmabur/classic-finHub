'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');
const root=path.resolve(__dirname,'..');
const source=(name)=>fs.readFileSync(path.join(root,name),'utf8');
const financialData={
 available:true,periodLabel:'2026-11-01 to 2026-11-17',
 byModule:[{moduleKey:'forex',totals:[{currency:'UGX',formatted:'UGX 100,000'}]}],
 moduleEarnings:[{moduleKey:'forex',income:[{currency:'SSP',formatted:'SSP 2,000'}],expenses:[],net:[{currency:'SSP',formatted:'SSP 2,000'}]}]
};
test('legacy two-column rule excludes explicit overview and module stats containers',()=>{
 const css=source('public/css/dashboard-layout.css');
 assert.match(css,/:has\(>\.stat\):not\(\.overviewStatsGrid\):not\(\.moduleStatsGrid\)/);
 assert.match(css,/@media \(min-width:900px\)[\s\S]*?#workspaceContent #view-overview \.overviewStatsGrid,[\s\S]*?repeat\(4,minmax\(0,1fr\)\)!important/);
 assert.match(css,/#workspaceContent \.financialModuleOverview \.moduleStatsGrid/);
});
test('Forex report summary actually renders financial stats before the record table',async()=>{
 const file=path.join(root,'src/views/tenant/operation-workspace.ejs');
 const html=await ejs.renderFile(file,{
  data:{moduleKey:'forex',title:'Forex report summary',label:'Forex',mode:'report',
   basePath:'/tenant/forex',total:0,note:'Quote records',
   filters:{from:'2026-11-01',to:'2026-11-17'},rows:[],canExport:false,
   financeOverview:financialData},
  user:{role:'Tenant Owner'},businessTimeZone:'Africa/Juba',
  formatLocalDate:()=>'',currencyLabel:code=>code
 });
 assert.match(html,/Financial|Operating assets/);
 assert.match(html,/Posted net income/);
 assert.match(html,/UGX 100,000/);
 assert.match(html,/SSP 2,000/);
 assert.match(html,/moduleStatsGrid/);
 assert.ok(html.indexOf('moduleStatsGrid')<html.indexOf('Filter summary'));
});
test('Forex report summary shows unavailable evidence instead of hiding stats',async()=>{
 const file=path.join(root,'src/views/tenant/operation-workspace.ejs');
 const html=await ejs.renderFile(file,{
  data:{moduleKey:'forex',title:'Forex report summary',label:'Forex',mode:'report',
   basePath:'/tenant/forex',total:0,note:'Quote records',filters:{from:'2026-11-01',to:'2026-11-17'},rows:[],
   financeOverview:{available:false,reason:'Choose a viewing branch'},canExport:false},
  user:{role:'Tenant Owner'},businessTimeZone:'Africa/Juba'
 });
 assert.match(html,/Choose a viewing branch/);
 assert.match(html,/Financial summary/);
});
test('all four module report routes load real finance snapshots',()=>{
 const ops=source('src/tenant/routes/operationWorkspace.routes.js');
 assert.match(ops,/data\.financeOverview=await require\('\.\.\/services\/financeOverview\.service'\)\.moduleOverview/);
 const general=source('src/views/tenant/operation-workspace.ejs');
 assert.match(general,/include\('partials\/module-finance'/);
 const momo=source('src/tenant/routes/mobileMoneyWorkspace.routes.js');
 assert.match(momo,/financeOverview:\s*await|financeOverview,reportData/);
 assert.match(source('src/views/tenant/mobile-money/report.ejs'),/include\('\.\.\/partials\/module-finance'/);
});


test('Forex operator sees real report counters even without restricted Treasury totals',async()=>{
 const html=await ejs.renderFile(path.join(root,'src/views/tenant/operation-workspace.ejs'),{
  data:{moduleKey:'forex',title:'Forex report summary',label:'Forex',mode:'report',
   basePath:'/tenant/forex',total:6,note:'Quotes and manual movements',
   filters:{from:'2026-11-01',to:'2026-11-17'},
   rows:[
    {day:'2026-11-17',status:'quoted',kind:'buy',currency:'UGX',targetCurrency:'SSP',count:2,volume:'UGX 2,000',target:'SSP 1,800'},
    {day:'2026-11-17',status:'posted_manual',kind:'sell',currency:'UGX',targetCurrency:'SSP',count:3,volume:'UGX 3,000',target:'SSP 3,300'},
    {day:'2026-11-16',status:'rejected',kind:'sell',currency:'SSP',targetCurrency:'UGX',count:1,volume:'SSP 100',target:'UGX 120'}
   ],canExport:false,
   financeOverview:{available:false,reason:'Treasury permission required'}},
  user:{role:'Forex Operator'},businessTimeZone:'Africa/Juba',currencyLabel:code=>code
 });
 assert.match(html,/Forex operational report statistics/);
 assert.match(html,/Records in selected period<\/div><div class="v">6<\/div>/);
 assert.match(html,/Awaiting next step<\/div><div class="v">2<\/div>/);
 assert.match(html,/Posted \/ paid out internally<\/div><div class="v">3<\/div>/);
 assert.match(html,/Currencies represented<\/div><div class="v">2<\/div>/);
 assert.doesNotMatch(html,/Operating assets · book/,'restricted Treasury totals must not leak');
});
test('Money Transfer collected funds remain pending until internal payout, not marked completed',async()=>{
 const html=await ejs.renderFile(path.join(root,'src/views/tenant/operation-workspace.ejs'),{
  data:{moduleKey:'money_transfer',title:'Transfer report summary',label:'Money Transfer',mode:'report',
   basePath:'/tenant/money-transfer',total:5,note:'Manual transfer states',
   filters:{from:'2026-11-01',to:'2026-11-17'},
   rows:[
    {day:'2026-11-17',status:'collected_manual',kind:'transfer_request',currency:'SSP',count:2,volume:'SSP 200',fees:'SSP 0'},
    {day:'2026-11-17',status:'requested',kind:'transfer_request',currency:'SSP',count:1,volume:'SSP 100',fees:'SSP 0'},
    {day:'2026-11-17',status:'paid_out_manual',kind:'transfer_request',currency:'SSP',count:1,volume:'SSP 100',fees:'SSP 0'},
    {day:'2026-11-17',status:'rejected',kind:'transfer_request',currency:'SSP',count:1,volume:'SSP 100',fees:'SSP 0'}
   ],canExport:false,
   financeOverview:{available:false,reason:'Treasury permission required'}},
  user:{role:'Money Transfer Operator'},businessTimeZone:'Africa/Juba',currencyLabel:code=>code
 });
 assert.match(html,/Awaiting next step<\/div><div class="v">3<\/div>/);
 assert.match(html,/Posted \/ paid out internally<\/div><div class="v">1<\/div>/);
 assert.match(html,/not proof of provider settlement/);
});
