'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const ejs=require('ejs');
const src=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const account=(id,currency,status,minor,kind='cash')=>({
 _id:id,branchId:'0123456789abcdef01234567',name:`Real ${currency} ${kind}`,
 currency,kind,network:'',status,integrityBlocked:false,
 reconciliationState:status==='held'?'mismatch':status==='active'?'matched':'unknown',
 bookBalanceMinor:minor,expectedFormatted:currency+' '+minor,
 openingBalanceMinor:status==='uninitialized'?null:minor,
 openingApprovedAt:status==='uninitialized'?null:new Date(),
 lastObservedMinor:status==='held'?'50':minor,
 lastExpectedAtObservationMinor:minor,lastVarianceMinor:status==='held'?'-20':'0',
 lastObservationAt:status==='uninitialized'?null:new Date(),lastObservationStale:false,
 pendingOpeningId:null,sequence:status==='uninitialized'?0:1,openingObservedAt:new Date()
});
const ugx=account('111111111111111111111111','UGX','active','500');
const ssp=account('222222222222222222222222','SSP','uninitialized','0');
const ksh=account('333333333333333333333333','KES','held','70','wallet');
ksh.network='MTN';
ksh.sequence=0; // A mistyped opening with no financial operations is correctable.
const keys=Object.fromEntries([ugx,ssp,ksh].map(a=>[a._id,{
 opening:'00000000-0000-4000-8000-000000000001',
 capital:'00000000-0000-4000-8000-000000000002',
 check:'00000000-0000-4000-8000-000000000003',
 correction:'00000000-0000-4000-8000-000000000004'
}]));
const locals={
 user:{id:'444444444444444444444444',role:'Tenant Owner',permissions:['*']},
 data:{
  snapshot:{accounts:[ugx,ssp,ksh],note:''},
  ownerFormKeys:keys,canManage:true,canCreateAccount:true,canObserve:true,
  canReview:true,queue:[],setupBranch:{_id:'0123456789abcdef01234567',currency:'UGX',currencies:['UGX','SSP','KES']},
  kinds:['cash','wallet','bank'],networks:['MTN'],
  currencyCodes:['UGX','USD','SSP','KES'],fundingAccounts:[],fundings:[],
  fundingIdempotencyKey:'00000000-0000-4000-8000-000000000005',
  idempotencyKey:'00000000-0000-4000-8000-000000000006',
  fundingDestination:'',showFundingHistory:false,allBranches:false,
  branchNames:{},format:(amount,currency)=>currency+' '+amount
 },
 csrfToken:'test-csrf',assetVersion:'test'
};
const view=path.join(__dirname,'../src/views/tenant/treasury/index.ejs');
test('Money is one rendered owner screen with real account forms, each currency separate',async()=>{
 const html=await ejs.renderFile(view,locals);
 for(const currency of ['UGX','SSP','KSH'])assert.match(html,new RegExp(currency+' accounts'));
 for(const id of [ugx._id,ssp._id,ksh._id])assert.match(html,new RegExp('money-account-'+id));
 assert.match(html,/action="\/tenant\/setup\/account"/);
 assert.match(html,/data-money-create-operator-field/);
 assert.match(html,/data-money-create-kind/);
 assert.match(html,/data-money-create-network-field/);
 assert.match(html,/action="\/tenant\/treasury\/accounts\/222222222222222222222222\/opening"/);
 assert.match(html,/action="\/tenant\/treasury\/accounts\/111111111111111111111111\/record"/);
 assert.match(html,/name="recordAction" value="capital"/);
 assert.match(html,/name="recordAction" value="check"/);
 assert.match(html,/action="\/tenant\/treasury\/accounts\/111111111111111111111111\/rename"/);
 assert.match(html,/action="\/tenant\/treasury\/accounts\/333333333333333333333333\/correct-opening"/);
 assert.match(html,/href="\/tenant\/cash\/shifts"/);
 assert.match(html,/id="add-funds"/);
 assert.doesNotMatch(html,/accounts across currencies|setupStatsGrid|Opening status<\/th>/i);
 assert.doesNotMatch(html,/action="\/tenant\/treasury\/accounts\/333333333333333333333333\/remove"/);
 assert.match(html,/name="_csrf" value="test-csrf"/);
 assert.match(html,/idempotencyKey/);
 assert.match(html,/\/js\/tenant-money-workspace\.js/);
});
test('Money posts strict semantics; a counted total never turns into unearned capital',()=>{
 const route=src('src/tenant/treasury/routes.js'),money=src('src/views/tenant/treasury/_owner-accounts.ejs');
 assert.match(route,/recordAction\|\|req\.body\.action/);
 assert.match(route,/treasury\.addCapital/);
 assert.match(route,/treasury\.recordOwnerBalanceCheck/);
 assert.match(route,/treasury\.correctUnusedOpening/);
 assert.match(route,/treasury\.balanceSnapshot/);
 assert.match(money,/New business money received/);
 assert.match(money,/Total actually counted now/);
 assert.match(money,/A used account requires a fresh, verified zero balance/);
 assert.doesNotMatch(money,/deleteOne\(|deleteMany\(/);
});
test('Unused opening typo correction keeps ledger and enforces financial activity fence',()=>{
 const svc=src('src/tenant/treasury/service.js');
 const start=svc.indexOf('async function correctUnusedOpening');
 const end=svc.indexOf('// A capital contribution is NEW',start);
 assert(start>0&&end>start);
 const code=svc.slice(start,end);
 for(const required of [
  'await assertBookIntegrity','await applyMovements','await requestObservationInSession',
  'await reviewObservationInSession','treasury.opening_typo.corrected',
  "account.sequence||0","core.cashSessionModel","core.mobileTransactionModel",
  "ledgerLines:","ownerDirectCheck:true"
 ])assert(code.includes(required),required);
 assert.doesNotMatch(code,/deleteOne\(|deleteMany\(|dropDatabase\(/);
});
