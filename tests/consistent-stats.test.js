'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');

const ROOT=path.resolve(__dirname,'..');
const read=source=>fs.readFileSync(path.join(ROOT,source),'utf8');
const render=(source,locals={})=>ejs.renderFile(path.join(ROOT,source),locals);

test('tenant and platform use the same approved stat stylesheet after tenant theme',()=>{
 const layout=read('src/views/layouts/dashboard.ejs');
 const theme=layout.indexOf('/tenant/workspace/theme.css');
 const shared=layout.indexOf('/css/stat-system.css');
 assert(theme>=0&&shared>theme,'Stat stylesheet loads after the tenant theme and existing dashboard CSS');
 const css=read('public/css/stat-system.css');
 for(const token of ['#workspaceContent .stat','stat--text','overviewCurrencyLines',
  'border-top:1px solid var(--border)','grid-template-columns:repeat(2,minmax(0,1fr))']){
  assert(css.includes(token),'Missing approved style rule: '+token);
 }
 assert(!css.includes('position:fixed'),'Statistics must remain in normal page flow');
});

test('shared stat card keeps currency values distinct, escapes untrusted labels and uses KSH display',async()=>{
 const html=await render('src/views/partials/stat-card.ejs',{
  title:'Cash <unsafe>',value:'3 transactions',note:'Posted only',noteDot:true,
  items:[{currency:'UGX',formatted:'UGX 1,200',count:2},{currency:'KES',formatted:'KES 500',count:1}]
 });
 assert.match(html,/class="stat"/);
 assert.match(html,/Cash &lt;unsafe&gt;/);
 assert.doesNotMatch(html,/<unsafe>/);
 assert.match(html,/UGX 1,200/);
 assert.match(html,/KSH 500/);
 assert.match(html,/2 transactions/);
 assert.match(html,/1 transaction/);
 assert(!/3,?700/.test(html),'Never add unlike currency amounts into one total');
 const usd=await render('src/views/partials/stat-card.ejs',{
  title:'Exchange volume',value:'USD 40',items:[
    {currency:'UGX',formatted:'UGX 100'},{currency:'USD',formatted:'USD 40'}],
  currencyFilter:'USD'
 });
 assert.match(usd,/USD 40/);
 assert.doesNotMatch(usd,/UGX 100/);
});

test('tenant overview and platform overview use the SAME stat component',async()=>{
 const tenant=await render('src/views/tenant/partials/overview-stat-card.ejs',{
  title:'Transactions',value:'5 transactions',
  items:[{currency:'SSP',formatted:'SSP 8,000',count:5}],note:'Local business day'
 });
 const platform=await render('src/views/platform/dashboard/index.ejs',{
  data:{totalTenants:4,activeTenants:3,suspendedTenants:1,appointmentCount:2,
   availableModuleCount:7,tenants:[],recentAudits:[]}
 });
 assert.match(tenant,/class="stat"/);
 assert.match(platform,/class="stat"/);
 assert.match(platform,/Total workspaces/);
 assert.match(platform,/Active workspaces/);
 assert.match(platform,/Onboarding appointments/);
 assert.match(tenant,/SSP 8,000/);
 assert.equal((platform.match(/class="stat"/g)||[]).length,3);
});

test('directory cards show real scoped counts instead of invented account balances or icon metrics',async()=>{
 const accounts=await render('src/views/tenant/customer-accounts/accounts.ejs',{
  data:{mode:'balances',records:{total:12,items:[],q:'',nextCursor:null},
   canManageAccount:false,canBank:false}
 });
 assert.match(accounts,/Matching accounts/);
 assert.match(accounts,/Displayed accounts/);
 assert.doesNotMatch(accounts,/class="k">Account balances/);
 assert.doesNotMatch(accounts,/class="v">UGX \/ USD \/ SSP \/ KSH/);
 const customers=await render('src/views/tenant/customer-accounts/customers.ejs',{
  data:{records:{total:5,accounts:3,items:[],q:'',status:'active'},
   canCreateCustomer:false,canExportCustomer:false}
 });
 assert.match(customers,/Profiles displayed/);
 assert.doesNotMatch(customers,/class="k">Customer activity/);
});

test('all dashboard stat templates still compile after applying shared stat styles',()=>{
 const directories=['src/views/platform','src/views/tenant','src/views/partials'];
 let count=0;
 const scan=dir=>{
  for(const entry of fs.readdirSync(path.join(ROOT,dir),{withFileTypes:true})){
   const next=path.join(dir,entry.name);
   if(entry.isDirectory()){scan(next);continue;}
   if(!entry.name.endsWith('.ejs'))continue;
   assert.doesNotThrow(()=>ejs.compile(read(next),{filename:path.join(ROOT,next)}),'Cannot compile '+next);
   count++;
  }
 };
 for(const directory of directories)scan(directory);
 assert(count>100,'Expected comprehensive native tenant/platform template coverage');
});
