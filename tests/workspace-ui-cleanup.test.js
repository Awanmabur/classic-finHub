'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ejs=require('ejs');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('logout has only central sign-out dialog and branch switch shows a single main-panel flash',()=>{
 const feedback=read('public/js/feedback.js');
 const layout=read('src/views/layouts/dashboard.ejs');
 const branch=read('src/tenant/services/branchView.service.js');
 const css=read('public/css/feedback.css');
 assert.match(feedback,/action\.pathname==='\/logout'/);
 assert.match(feedback,/action\.pathname==='\/tenant\/view-branch'/);
 assert.match(feedback,/main\.panel\.main/);
 assert.match(layout,/id="dashboardSignoutDialog"/);
 assert.match(branch,/flash\(req,'good'/);
 assert.match(branch,/operating branch is unchanged/);
 assert.match(css,/\.main>\.sessionFeedback\{[^}]*position:fixed;top:50%;left:50%/);
});

test('current live pricing keeps individual published plan modules distinct from optional addons',()=>{
 const source=read('src/views/original/pricing.ejs');
 const compare=read('src/views/original/price-compare.ejs');
 const routes=read('src/routes.public.js');
 const admin=read('src/views/platform/plans/index.ejs');
 assert.match(routes,/addonModules:store\.modules\.filter/);
 assert.match(source,/Included with this plan/);
 assert.match(source,/Optional add-ons/);
 assert.match(source,/plan\.moduleLabels\|\|plan\.modules/);
 assert.match(compare,/Optional add-ons/);
 assert.match(admin,/plan\.modules/);
 assert.match(admin,/Separate add-on catalogue/);
 assert.doesNotMatch(routes,/addonModules:store\.plans/);
});

test('tenant setup preview reports current recorded entitlements without changing audited controls',async()=>{
 const date=new Date('2030-11-01T00:00:00.000Z');
 const tenant={_id:'507f1f77bcf86cd799439011',id:'507f1f77bcf86cd799439011',name:'Tenant A',owner:'Owner',email:'owner@example.invalid',phone:'',status:'active',setupStatus:'complete',plan:'agent',enabledModules:['mobile_money'],seatsReserved:2,branchCount:1,__v:1,
  subscription:{planName:'Agent Plan',planCode:'agent',planVersion:3,status:'granted',periodEnd:date,limits:{users:5,branches:2},modules:['mobile_money','reports']},
  moduleGrants:[{moduleKey:'analytics',status:'granted',periodStart:new Date('2026-01-01'),periodEnd:date,limits:{users:5,branches:2,recordsPerMonth:0}}]};
 const base={data:{tenant,modules:require('../src/data/store').modules,published:[],independentModules:[],effectivePlan:tenant.subscription,activeAddonGrants:tenant.moduleGrants},csrfToken:'csrf',formatUtcDate:require('../src/utils/view').formatUtcDate};
 const render=data=>ejs.renderFile(path.join(__dirname,'../src/views/platform/tenants/show.ejs'),{...base,data});
 const active=await render(base.data);
 assert.match(active,/Current workspace state/);
 assert.match(active,/Agent Plan · agent v3/);
 assert.match(active,/Current plan modules available/);
 assert.match(active,/1 of 2 in saved terms/);
 assert.match(active,/Analytics · active/);
 assert.match(active,/summary class="cardHead"/);
 assert.match(active,/action="\/platform\/tenants\/507f1f77bcf86cd799439011\/subscription\/grant"/);
 const inactive=await render({...base.data,effectivePlan:null,activeAddonGrants:[]});
 assert.match(inactive,/Inactive \/ expired \/ revoked/);
 assert.match(inactive,/0 of 2 in saved terms/);
 assert.doesNotMatch(inactive,/Analytics · active/);
});

test('Mobile Money onboarding uses real account-opening approval and cash shifts routes',()=>{
 const mobile=read('src/views/tenant/mobile-money/index.ejs');
 const treasury=read('src/views/tenant/treasury/index.ejs');
 const dashboard=read('src/views/tenant/dashboard/index.ejs');
 for(const link of ['/tenant/treasury#account-setup','/tenant/treasury/review','/tenant/cash/shifts'])assert(mobile.includes(link),link);
 assert.match(mobile,/data-mobile-onboarding/);
 assert.match(treasury,/id="account-setup"/);
 assert.match(treasury,/id="treasury-accounts"/);
 assert.match(dashboard,/data-dashboard-fund-stat/);
 assert.doesNotMatch(dashboard,/mobileDashboardBalances/);
});
