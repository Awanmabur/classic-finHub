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
