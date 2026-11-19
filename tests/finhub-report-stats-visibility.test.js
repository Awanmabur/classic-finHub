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
test('single shared stat stylesheet enforces 4-up PC and 2-up phone in tenant and platform',()=>{
 const css=source('public/css/stat-system.css');
 const legacy=source('public/css/dashboard-layout.css');
 assert.match(css,/#workspaceContent :is\(\.grid3,\.stats,\.backupStats,[\s\S]*?:has\(>\.stat\)\{[\s\S]*?repeat\(4,minmax\(0,1fr\)\)!important/);
 assert.match(css,/@media \(max-width:899\.98px\)[\s\S]*?:has\(>\.stat\)\{[\s\S]*?repeat\(2,minmax\(0,1fr\)\)!important/);
 assert.match(css,/@media \(max-width:600px\)[\s\S]*?:has\(>\.stat\)\{[\s\S]*?repeat\(2,minmax\(0,1fr\)\)!important/);
 assert.doesNotMatch(legacy,/:has\(>\.stat\):not\(\.overviewStatsGrid\)/,'Do not reintroduce competing legacy two-column desktop grid');
 assert.match(legacy,/#workspaceContent \.financialModuleOverview \.moduleStatsGrid/);
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

test('posted Forex exchanges appear in reports without pretending spread is recognized profit',async()=>{
 const file=path.join(root,'src/views/tenant/operation-workspace.ejs');
 const html=await ejs.renderFile(file,{
  data:{moduleKey:'forex',title:'Forex report summary',label:'Forex',mode:'report',
   basePath:'/tenant/forex',total:2,note:'Quoted and posted activity',
   filters:{from:'2026-11-01',to:'2026-11-18'},rows:[],canExport:false,
   financeOverview:{...financialData,forexActivity:{
    limited:false,count:2,
    bought:[{currency:'USD',formatted:'USD 10.00'}],
    sold:[{currency:'USD',formatted:'USD 5.00'}]
   }}},
  user:{role:'Tenant Owner'},businessTimeZone:'Africa/Juba',
  formatLocalDate:()=>'',currencyLabel:code=>code
 });
 assert.match(html,/Actual Forex exchanges/);
 assert.match(html,/2 completed exchanges/);
 assert.match(html,/USD 10.00/);
 assert.match(html,/USD 5.00/);
 assert.match(html,/not net income or realized trading profit/);
});
test('phone financial stats are two-up and long tables remain horizontally scrollable',()=>{
 const css=source('public/css/dashboard-layout.css');
 assert.match(css,/@media \(max-width:599\.98px\)/);
 assert.match(css,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)!important/);
 assert.match(css,/overscroll-behavior-x:contain/);
 assert.match(css,/-webkit-overflow-scrolling:touch/);
});
