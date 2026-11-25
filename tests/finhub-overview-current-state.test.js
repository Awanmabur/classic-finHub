'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');
const finance=require('../src/tenant/services/financeOverview.service');

const id='507f1f77bcf86cd799439011';

test('book balances keep currencies separate and preserve signs',()=>{
 const amounts=finance.groupMoney([
  {currency:'UGX',bookBalanceMinor:'10000'},
  {currency:'UGX',bookBalanceMinor:'-1000'},
  {currency:'SSP',bookBalanceMinor:'700'},
  {currency:'USD',bookBalanceMinor:'300'},
  {currency:'INVALID',bookBalanceMinor:'5'}
 ],'bookBalanceMinor');
 assert.equal(amounts.get('UGX'),9000n);
 assert.equal(amounts.get('SSP'),700n);
 assert.equal(amounts.get('USD'),300n);
 assert.equal(amounts.has('INVALID'),false);
 const rows=finance.rowsOf(amounts);
 assert.equal(rows.length,3);
 assert.equal(rows.find(x=>x.currency==='UGX').amountMinor,'9000');
});
test('non-owner cannot pick another branch to read capital or earnings',()=>{
 const user={role:'Branch Manager',branchId:id};
 assert.equal(finance.branchScope(user,{viewBranch:{_id:'507f1f77bcf86cd799439012'}}),null);
 assert.equal(String(finance.branchScope(user,{operationBranch:{_id:id}}).branchId),id);
 assert.deepEqual(finance.branchScope({role:'Tenant Owner'},{viewBranchId:'all'}),{});
});

test('dashboard shows posted earnings above activity and omits unmeasured Forex profit',()=>{
 const file=path.join(__dirname,'../src/views/tenant/dashboard/index.ejs');
 const view=fs.readFileSync(file,'utf8');
 const html=ejs.render(view,{
  businessTimeZone:'Africa/Juba',
  data:{
   hasTransfer:false,hasMobileMoney:true,hasBanking:false,hasForex:true,
   mobileMarkets:[],mobileFunds:{wallets:[],paymentAccounts:[]},mobileBookTotals:{cash:[],float:[]},
   financeOverview:{available:true,mixedRegion:false,postedNet:[{currency:'SSP',formatted:'SSP 7,000'}],
    postedIncome:[{currency:'SSP',formatted:'SSP 10,000'}],bookAssets:[{currency:'SSP',formatted:'SSP 100,000'}],byModule:[]},
   workspaceSnapshot:{todayVolumes:{forex:{formatted:'USD 0'},mobile_money:{formatted:'UGX 0'}},
    todayByCurrency:{forex:[{currency:'USD',count:1,formatted:'USD 100.00'}]}}
  },quickActions:[],user:{role:'Tenant Owner',permissions:['*']},
  visiblePaths:new Set(),tenant:{slug:'demo'},currencyOptions:[{code:'SSP',label:'SSP'}]
 },{filename:file});
 assert.match(html,/Posted net income/);
 assert.match(html,/SSP 7,000/);
 assert.match(html,/Operating assets/);
 assert.doesNotMatch(html,/Forex trading profit|Not yet measurable/);
 assert.match(html,/aria-labelledby="dashboardFinancialDetails"[\s\S]*class="dashboardFinancialGroups"/);
});
test('platform tenant form reflects persisted active state and effective module entitlements',()=>{
 const file=path.join(__dirname,'../src/views/platform/tenants/show.ejs');
 const sub={planCode:'starter',planName:'Starter',planVersion:1,status:'granted',
  periodStart:new Date('2026-11-01T00:00:00Z'),periodEnd:new Date('2027-11-01T00:00:00Z'),
  modules:['forex'],limits:{users:5,branches:2}};
 const html=ejs.render(fs.readFileSync(file,'utf8'),{
  data:{tenant:{id,slug:'demo',name:'Demo',owner:'Test Owner',email:'owner@example.test',phone:'',
    status:'active',setupStatus:'complete',subscription:sub,enabledModules:['forex'],moduleGrants:[],
    seatsReserved:1,branchCount:1,__v:0},
   effectivePlan:sub,activeAddonGrants:[],modules:[{key:'forex',name:'Forex',runtimeStatus:'active'}],
   published:[{code:'starter',name:'Starter'}],independentModules:[{key:'forex',category:'Standalone',name:'Forex',priceMonthly:5,requiresRecords:true}]},
  csrfToken:'test-csrf',formatUtcDate:value=>new Date(value).toISOString()
 },{filename:file});
 assert.match(html,/Current: active/);
 assert.match(html,/Forex · enabled/);
 assert.match(html,/Current: Starter/);
 assert.match(html,/Current workspace state/);
});

test('posted module earnings classify actual journals by source without counting Forex volume',async t=>{
 const mongoose=require('mongoose');
 const core=require('../src/tenant/models');
 const treasury=require('../src/tenant/treasury/models');
 const conn=mongoose.createConnection();
 t.after(()=>conn.close());
 const Batch=treasury.models(conn).batch;
 const Posting=core.ledgerPostingModel(conn);
 const j1=new mongoose.Types.ObjectId('507f1f77bcf86cd799439021');
 const j2=new mongoose.Types.ObjectId('507f1f77bcf86cd799439022');
 const rows=[
  {sourceType:'mobile_money',journalIds:[j1]},
  {sourceType:'expenses',journalIds:[j2]}
 ];
 t.mock.method(Batch,'find',()=>({
  select:()=>({limit:()=>({maxTimeMS:()=>({lean:async()=>rows})})})
 }));
 const posted=[
  {_id:{journalId:j1,currency:'UGX',category:'income',side:'credit'},amount:'1200'},
  {_id:{journalId:j2,currency:'UGX',category:'expense',side:'debit'},amount:'300'}
 ];
 t.mock.method(Posting,'aggregate',()=>({option:async()=>posted}));
 const report=await finance.postedEarningsByModule(conn,{_id:id},{},{
  now:new Date('2026-11-17T12:00:00Z'),timeZone:'Africa/Juba'
 });
 assert.equal(report.find(r=>r.moduleKey==='mobile_money').income[0].amountMinor,'1200');
 assert.equal(report.find(r=>r.moduleKey==='expenses').net[0].amountMinor,'-300');
 assert.equal(report.some(r=>r.moduleKey==='forex'),false);
});

test('a dashboard supervisor receives earnings only from assigned modules',async t=>{
 const mongoose=require('mongoose');
 const core=require('../src/tenant/models');
 const {models}=require('../src/tenant/treasury/models');
 const {entitledTenant}=require('./helpers/entitlement');
 const conn=mongoose.createConnection();
 t.after(()=>conn.close());
 const journalId=new mongoose.Types.ObjectId();
 const tenant=entitledTenant({_id:id,plan:'enterprise',enabledModules:['mobile_money','forex']});
 const user={role:'Branch Manager',branchId:id,allowedModules:['mobile_money'],
  permissions:['treasury.view','mobile_money.view','forex.view']};
 t.mock.method(models(conn).account,'find',query=>{
  assert.deepEqual(query.moduleKey.$in,['shared','mobile_money']);
  return {select:()=>({limit:()=>({lean:async()=>[
   {moduleKey:'shared',currency:'UGX',bookBalanceMinor:'9000'}
  ]})})};
 });
 t.mock.method(models(conn).batch,'find',query=>{
  assert.deepEqual(query.sourceType.$in,['mobile_money']);
  return {select:()=>({limit:()=>({maxTimeMS:()=>({lean:async()=>[{sourceType:'mobile_money',journalIds:[journalId]}]})})})};
 });
 t.mock.method(core.ledgerPostingModel(conn),'aggregate',pipeline=>{
  assert.deepEqual(pipeline[0].$match.journalId.$in,[journalId]);
  return {option:async()=>[
   {_id:{journalId,currency:'UGX',category:'income',side:'credit'},amount:'1200'}
  ]};
 });
 const result=await finance.overview(conn,tenant,user,{
  operationBranch:{_id:id},scopeToAssignedModules:true,now:new Date('2026-11-17T12:00:00Z')
 });
 assert.equal(result.postedNet[0].amountMinor,'1200');
 assert.equal(result.bookAssets[0].amountMinor,'9000');
 assert.deepEqual(result.moduleEarnings.map(row=>row.moduleKey),['mobile_money']);
});
