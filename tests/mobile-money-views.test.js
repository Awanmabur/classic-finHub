'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const path = require('node:path');
const {fromMinor} = require('../src/tenant/services/mobileMoney.service');
const views = path.resolve(__dirname,'../src/views/tenant/mobile-money');
const requestKey = '1b7db353-c630-4d62-b2c4-c396751ef77d';
const record = {_id:'507f1f77bcf86cd799439011',customer:'Customer <script>',customerPhone:'+256771234567',customerNote:'Receipt checked',network:'MTN',networkReference:'MTN-TEST1',operation:'cash_in',entrySource:'sms',currency:'UGX',amountMinor:'5000',feeMinor:'100',paymentMethod:'Cash',fundingState:'book_recorded',status:'pending_verification',reviewState:'awaiting_review',correctionState:'none',createdAt:new Date('2026-11-03T12:00:00Z')};
function options(overrides={}) {
  return {
    user:{id:'507f1f77bcf86cd799439012',role:'Mobile Money Operator',permissions:['mobile_money.view','mobile_money.cash_in','mobile_money.cash_out'],branchId:'aaaaaaaaaaaaaaaaaaaaaaaa'},
    operationBranch:{_id:'aaaaaaaaaaaaaaaaaaaaaaaa',name:'Assigned branch',currency:'UGX',status:'active'},
    csrfToken:'protected-csrf',money:(currency,amount)=>`${currency} ${amount}`,amountFromMinor:fromMinor,
    data:{reportData:{window:{key:'today',from:'2026-11-03',to:'2026-11-03'},
  currencies:[{currency:'UGX',depositCount:1,withdrawalCount:0,manualCount:0,smsCount:1,
   pendingReviewCount:1,providerUnverifiedCount:1,voidedCount:0,
   volumeMinorFormatted:'UGX 5,000',cashImpactMinorFormatted:'UGX 5,000',
   receivedCommissionMinorFormatted:'UGX 0',collectedFeeMinorFormatted:'UGX 0',
   estimatedCommissionMinorFormatted:'UGX 100',recordedFeeMinorFormatted:'UGX 100',
   legacyWalletFeeMinorFormatted:'UGX 0',grossCommissionMinorFormatted:'UGX 0',
   withheldTaxMinorFormatted:'UGX 0',providerCostMinorFormatted:'UGX 0'}],
  networks:[{network:'MTN',currency:'UGX',depositCount:1,withdrawalCount:0,manualCount:0,smsCount:1,
   pendingReviewCount:1,providerUnverifiedCount:1,voidedCount:0,
   volumeMinorFormatted:'UGX 5,000',cashImpactMinorFormatted:'UGX 5,000',
   collectedFeeMinorFormatted:'UGX 0',estimatedCommissionMinorFormatted:'UGX 100',
   receivedCommissionMinorFormatted:'UGX 0'}],
  expenses:[],expensesAccessible:true,note:'Internal book figures, not provider settlement.'},
  formatMoneyMinor:(minor,currency)=>currency+' '+String(minor),
  operation:'cash_in',canRecord:true,canExport:true,idempotencyKey:requestKey,filters:{from:'2026-11-03',to:'2026-11-03',network:'MTN',currency:'UGX',entrySource:'sms'},records:{items:[record],nextCursor:'next-key'},networksAvailable:['MTN','Airtel','Africell','M-Pesa'],currencies:['UGX','USD','SSP','KES'],networks:[{network:'MTN',currency:'UGX',cashInCount:1,cashOutCount:0,formatted:{volume:'UGX 5,000',fees:'UGX 100'}}],summary:{total:1,activeCount:1,manualCount:0,smsCount:1,voidedCount:0,cashByCurrency:[{currency:'UGX',physicalCashInCount:1,physicalCashOutCount:0,formatted:{physicalCashIn:'UGX 5,000',physicalCashOut:'UGX 0',cashImpact:'UGX 5,000'}}],byCurrency:[{currency:'UGX',count:1,cashInCount:1,cashOutCount:0,physicalCashInCount:1,physicalCashOutCount:0,formatted:{cashIn:'UGX 5,000',cashOut:'UGX 0',physicalCashIn:'UGX 5,000',physicalCashOut:'UGX 0',cashImpact:'UGX 5,000',volume:'UGX 5,000',fees:'UGX 100'}}]}},
    ...overrides
  };
}
const render = (name,locals) => ejs.renderFile(path.join(views,`${name}.ejs`),locals);

test('approved mobile money entry preserves the protected server contract and assigned branch',async()=>{
  const html = await render('entry',options());
  assert.match(html,/action="\/tenant\/mobile-money\/cash-in"/);
  assert.match(html,/name="_csrf" value="protected-csrf"/);
  assert.match(html,new RegExp(`name="idempotencyKey" value="${requestKey}"`));
  for(const field of ['customer','customerPhone','network','networkReference','customerNote','amount','fee','currency','paymentMethod']) assert.match(html,new RegExp(`name="${field}"`));
  for(const label of ['Customer and network','Customer phone','Customer name','Network transaction reference','Customer ID / note','Amount and accounts','Additional agent service fee','Physical cash received from customer','Record deposit']) assert.ok(html.includes(label),label);
  assert.match(html,/<option value="Africell" data-market-currency=""(?: selected| disabled)*>Africell<\/option>/);
  assert.match(html,/name="paymentMethod" value="Cash"/);
  assert.doesNotMatch(html,/<option value="Wallet Balance">/);
  assert.doesNotMatch(html,/<option value="Bank">/);
  const currency = html.match(/<select\b[^>]*name="currency"[^>]*>([\s\S]*?)<\/select>/);
  assert(currency,'Approved currency control must be present');
  assert.deepEqual([...currency[1].matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(match=>match[1]),['UGX','USD','SSP','KES']);
  assert.match(html,/Assigned branch/);
  const transactionForm = html.match(/<form[^>]+data-mobile-money-form[\s\S]*?<\/form>/)[0];
  assert.doesNotMatch(transactionForm,/<(?:select|input)[^>]+name="branchId"/);
  assert.doesNotMatch(html,/name="branchId"/);
  assert.match(html,/Recorded operations/);
  assert.match(html,/Recorded in books/);
  assert.match(html,/Customer &lt;script&gt;/);
  assert.doesNotMatch(html,/Customer <script>/);
});

test('entry offers only the saved branch currencies and selects SSP with exact cent precision',async()=>{
 const locals=options();locals.operationBranch.currencies=['USD','SSP'];locals.operationBranch.currency='USD';
 locals.data.entryCurrency='SSP';locals.data.networksAvailable=[...require('../src/config/mobileNetworks').networks];
 const html=await render('entry',locals),currency=html.match(/<select\b[^>]*name="currency"[^>]*>([\s\S]*?)<\/select>/);
 assert.deepEqual([...currency[1].matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(match=>match[1]),['USD','SSP']);
 assert.match(currency[1],/value="SSP" selected/);assert.match(html,/data-currency="SSP"/);
 assert.match(html,/value="MTN SSD" data-market-currency="SSP" selected>MTN MoMo South Sudan<\/option>/);assert.match(html,/pattern="\[0-9\]\{1,11\}\(\[\.\]\[0-9\]\{1,2\}\)\?"/);
});

test('cash-out has its own protected action and tabs respect exact operation permissions',async()=>{
  const locals = options(); locals.data.operation='cash_out'; locals.user.permissions=['mobile_money.view','mobile_money.cash_out'];
  const html = await render('entry',locals);
  assert.match(html,/action="\/tenant\/mobile-money\/cash-out"/);
  assert.match(html,/Mobile Money - Withdraw/);
  assert.match(html,/data-mobile-operation="cash_out"/);
  assert.doesNotMatch(html,/data-mobile-operation="cash_in"/);
  locals.data.canRecord=false;
  const readonly = await render('entry',locals);
  assert.doesNotMatch(readonly,/data-mobile-money-form/);
  assert.doesNotMatch(readonly,/Record withdrawal/);
});

test('network activity and report use supplied totals, retained status, filters and pagination',async()=>{
  const network = await render('network',options());
  for(const header of ['Network','Customer deposits','Customer withdrawals','Transaction volume','Recorded fees (not profit)']) assert.ok(network.includes(`<th>${header}</th>`));
  assert.match(network,/UGX 5,000/);
  assert.match(network,/SMS capture/);
  assert.match(network,/Recorded in books/);
  assert.match(network,/Network settlement is not independently confirmed/);
  assert.match(network,/network=MTN/);
  assert.match(network,/entrySource=sms/);
  assert.match(network,/cursor=next-key/);
  const report = await render('report',options());
  for(const label of ['Mobile Money business report','Transaction volume','Net cash movement','Manual / SMS records','Voided originals','Approved operating expenses']) assert.ok(report.includes(label));
  assert.match(report,/\/tenant\/mobile-money\/report\/unified\.csv\?/);
  assert.doesNotMatch(report,/Report basis/);
  assert.doesNotMatch(report,/Entry source/);
  assert.match(report,/Reporting period/);
  const readonly = options(); readonly.data.canExport=false;
  assert.doesNotMatch(await render('report',readonly),/Export consolidated CSV/);
});

test('cash impact retains all approved cards and separates physical cash from recorded commissions',async()=>{
  const html = await render('cash-impact',options());
  for(const label of ['Deposit','Withdrawal','Net impact']) assert.ok(html.includes(label));
  assert.match(html,/real currency of the cashier/);
  assert.match(html,/Bank \/ Wallet Balance methods are excluded/);
  const empty = options(); empty.data.summary.cashByCurrency=[]; empty.data.records={items:[]};
  const emptyHtml = await render('cash-impact',empty);
  assert.match(emptyHtml,/<div class="k">Deposit<\/div>/);
  assert.match(emptyHtml,/<div class="k">Withdrawal<\/div>/);
  assert.match(emptyHtml,/<div class="k">Net impact<\/div>/);
});

test('network report keeps physical cash, provider float, received commissions and estimates separate',async()=>{
 const locals=options();
 locals.user.permissions.push('treasury.view');
 locals.data.funds={
  wallets:[{id:'w1',name:'MTN South Sudan agent float',kind:'wallet',network:'MTN SSD',currency:'SSP',expected:'SSP 500.00',observed:'SSP 500.00',variance:'SSP 0.00',reconciliation:'matched'}],
  paymentAccounts:[{id:'c1',name:'Operator cash drawer',kind:'cash',network:'',currency:'SSP',expected:'SSP 300.00',observed:'SSP 300.00',variance:'SSP 0.00',reconciliation:'matched'}]
 };
 locals.data.commissionReceived=[{network:'MTN SSD',currency:'SSP',receivedMinor:'1250',count:1}];
 locals.data.formatMoneyMinor=(minor,currency)=>currency+' '+(Number(minor)/100).toFixed(2);
 const html=await render('network',locals);
 for(const label of ['Physical cash','Electronic float','Operator cash drawer','MTN MoMo South Sudan','Received agent commissions','SSP 12.50','Reconcile balances'])assert(html.includes(label),label);
 assert.match(html,/Only independently reviewed and journal-posted provider credits/);
 assert.doesNotMatch(html,/Total profit: SSP 12.50/);
});

test('network activity handler supplies a money formatter when actual payouts exist',()=>{
 const fs=require('node:fs');
 const route=fs.readFileSync(path.join(__dirname,'../src/tenant/routes/mobileMoneyWorkspace.routes.js'),'utf8');
 assert.match(route,/commissionReceived,formatMoneyMinor:require\('\.\.\/services\/mobileMoney\.service'\)\.formatMoneyMinor/);
 assert.match(route,/commissionPayoutService'\)\.summary/);
});

test('deposit and withdrawal entry displays scoped actual book balances and network-set currency',async()=>{
 const context=options();
 context.data.networksAvailable=[...require('../src/config/mobileNetworks').networks];
 context.operationBranch.currencies=['UGX','SSP'];
 context.data.funds={wallets:[{id:'wa',name:'MTN South Sudan float',kind:'wallet',network:'MTN SSD',currency:'SSP',expected:'SSP 250.00',expectedMinor:'25000',state:'active',reconciliation:'matched'}],paymentAccounts:[{id:'ca',name:'Agent drawer',kind:'cash',network:'',currency:'SSP',expected:'SSP 550.00',expectedMinor:'55000',state:'active',reconciliation:'matched'}],customerAccounts:[]};
 const html=await render('entry',context);
 assert.match(html,/data-market-currency="SSP"/);
 assert.match(html,/data-mobile-currency-field/);
 assert.match(html,/data-mobile-balance-stats/);
 assert.match(html,/SSP 250\.00/);
 assert.match(html,/SSP 550\.00/);
 assert.match(html,/Record deposit/);
 assert.doesNotMatch(html,/Available balance from provider network/);
});

test('main Mobile Money workspace shows genuine scoped cash and float book balance cards',async()=>{
 const locals=options();
 locals.data.funds={
  paymentAccounts:[{id:'cash1',kind:'cash',name:'Assigned cash drawer',currency:'UGX',expected:'UGX 120,000',expectedMinor:'120000',state:'active',reconciliation:'matched'}],
  wallets:[{id:'float1',kind:'wallet',name:'MTN Uganda wallet',network:'MTN',currency:'UGX',expected:'UGX 450,000',expectedMinor:'450000',state:'active',reconciliation:'matched'}],
  customerAccounts:[]
 };
 locals.data.reviewQueue=[];locals.data.voidQueue=[];locals.data.summary.recent=[];
 const html=await render('index',locals);
 for(const label of ['Cash and float balances','UGX 120,000','UGX 450,000','Physical cash','Electronic float','Assigned cash drawer','MTN Uganda wallet'])assert.ok(html.includes(label),label);

 assert.doesNotMatch(html,/Cash-in<\/a>|Cash-out<\/a>/);
});
test('Mobile Money entry and filters keep deposit and withdrawal labels, not cash-in/out labels',async()=>{
 const locals=options();
 const entry=await render('entry',locals);
 assert.match(entry,/Mobile Money - Deposit/);
 assert.doesNotMatch(entry,/>Cash-in<|>Cash-out</);
 const filters=require('node:fs').readFileSync(path.join(views,'_filters.ejs'),'utf8');
 assert.match(filters,/>Deposit<\/option>/);
 assert.match(filters,/>Withdrawal<\/option>/);
 assert.doesNotMatch(filters,/>Cash-in<\/option>|>Cash-out<\/option>/);
});

test('workspace CSS loads in tenant dashboard head before content and is not injected late by Mobile Money partials',()=>{
 const fs=require('node:fs');
 const layout=fs.readFileSync(path.join(__dirname,'../src/views/layouts/dashboard.ejs'),'utf8');
 assert.match(layout,/<link rel="stylesheet" href="\/css\/workspace\.css\?v=<%= assetVersion %>"/);
 assert(layout.indexOf('/css/workspace.css')<layout.indexOf('<body'));
 for(const name of ['index','entry','tariffs']){
  const partial=fs.readFileSync(path.join(views,name+'.ejs'),'utf8');
  assert.doesNotMatch(partial,/<link rel="stylesheet" href="\/css\/workspace\.css/);
 }
});

test('Mobile Money balance context is branch-scoped and no longer requires unrelated treasury viewing privilege',()=>{
 const fs=require('node:fs');
 const main=fs.readFileSync(path.join(__dirname,'../src/tenant/routes/index.js'),'utf8');
 const sub=fs.readFileSync(path.join(__dirname,'../src/tenant/routes/mobileMoneyWorkspace.routes.js'),'utf8');
 const funds=fs.readFileSync(path.join(__dirname,'../src/tenant/services/mobileMoneyFunds.service.js'),'utf8');
 assert.match(funds,/permission:'mobile_money.view',sourceType:'mobile_money'/);
 assert.match(funds,/branchId:branch\._id/);
 assert.match(funds,/operatorId:trusted\.actor\.id/);
 assert.match(main,/req\.operationBranch\?require\('\.\.\/services\/mobileMoneyFunds\.service'\)\.context/);
 assert.match(sub,/req\.operationBranch\?await require\('\.\.\/services\/mobileMoneyFunds\.service'\)\.context/);
});

test('authorized balance-readiness view provides actionable account status without financial fabrication',async()=>{
 const locals=options();
 locals.user.role='Tenant Owner';locals.user.permissions=['*'];
 locals.data.readiness={
  scope:'all assigned and shared accounts in operating branch',
  branchReady:true,
  accountCounts:{cash:0,wallet:0,bank:0,unopened:2,held:0,needsReconciliation:1,ready:0},
  providerAccountCounts:{},untrackedHistoricalOperationsPresent:true,truncated:false,
  guidance:'Configure an independently approved provider float wallet.'
 };
 const html=await render('readiness',locals);
 assert.match(html,/Physical cash accounts/);
 assert.match(html,/Provider float wallets/);
 assert.match(html,/Opening approval pending/);
 assert.match(html,/historical Mobile Money records without a funds-book posting/);
 assert.match(html,/\/tenant\/cash\/shifts/);
 assert.match(html,/\/tenant\/treasury/);
 assert.doesNotMatch(html,/verified actual provider balance: UGX/);
});

test('cross-currency exchange shows exact provider and drawer currency, quote movements, and posting blockers',async()=>{
 const common=options();
 Object.assign(common.data,{
  wallets:[{id:'wallet1',name:'MTN Uganda Float Wallet',network:'MTN',currency:'UGX'}],
  drawers:[{id:'drawer1',name:'SSP Cash Drawer',currency:'SSP'}],
  input:{operation:'withdraw_provider_receive_cash',walletAccountId:'wallet1',cashAccountId:'drawer1',providerAmount:'200000'},
  selectedBranchId:'aaaaaaaaaaaaaaaaaaaaaaaa',
  canExecute:false,
  blockers:['No active approved authorization for this exact provider wallet and cash drawer.'],
  result:{operation:'withdraw_provider_receive_cash',network:'MTN',providerCurrency:'UGX',cashCurrency:'SSP',
   rateSide:'buy',rateDecimal:'4000',walletName:'MTN Uganda Float Wallet',cashName:'SSP Cash Drawer',
   providerAmountMinor:'20000000',cashAmountMinor:'80000000000',walletDeltaMinor:'20000000',
   cashDeltaMinor:'-80000000000',rateExpiresAt:new Date('2026-11-19T12:00:00Z')}
 });
 common.formatLocalDate=()=> '19 Nov 2026';
 const html=await render('fx',common);
 for(const label of ['Exchange quote','Customer sends electronic money','Customer receives physical cash',
  'Wallet book movement','Drawer book movement','Exchange cannot be posted yet',
  'No active approved authorization for this exact provider wallet and cash drawer.'])
  assert.ok(html.includes(label),label);
 assert.match(html,/name="walletAccountId"/);
 assert.match(html,/name="cashAccountId"/);
 assert.match(html,/name="providerAmount"/);
 assert.doesNotMatch(html,/action="\/tenant\/mobile-money\/fx\/record"/);
 const ready=await render('fx',{...common,data:{...common.data,canExecute:true,blockers:[]}});
 assert.match(ready,/action="\/tenant\/mobile-money\/fx\/record"/);
 assert.match(ready,/name="providerReference"/);
 assert.match(ready,/name="providerAppConfirmed"/);
 assert.match(ready,/name="cashHandoverConfirmed"/);
});

test('one original cashier form supports same/cross currency without a second page',async()=>{
 const base=options();base.data.operation='cash_out';
 base.data.fxState={selected:true,wallets:[],drawers:[]};
 const html=await render('entry',base);
 assert.ok(html.includes('action="/tenant/mobile-money/cash-out"'));
 assert.ok(html.includes('data-mobile-money-form'));
 for(const name of ['walletAccountId','paymentAccountId','fxRateId','fxCashAmountMinor','providerAppConfirmed'])
  assert.ok(html.includes('name="'+name+'"'),name);
 assert.ok(html.includes('data-momo-unified-preview'));
 assert.ok(!html.includes('action="/tenant/mobile-money/fx/record"'));
 assert.ok(!html.includes('regulatoryAuthorizationReference'));
 const script=require('node:fs').readFileSync(path.resolve(__dirname,'../public/js/mobile-money-unified.js'),'utf8');
 assert.ok(script.includes('/tenant/mobile-money/fx/preview'));
 assert.ok(script.includes('result.cashAmountMinor'));
 const dashboard=require('node:fs').readFileSync(path.resolve(__dirname,'../public/js/dashboard.js'),'utf8');
 const layout=require('node:fs').readFileSync(path.resolve(__dirname,'../src/views/layouts/dashboard.ejs'),'utf8');
 const page=require('node:fs').readFileSync(path.resolve(__dirname,'../src/views/tenant/mobile-money/entry.ejs'),'utf8');
 assert.match(dashboard,/ClassicFinMobileUnified\?\.initialise\(form\)/,
  'Existing New transaction dialog must activate the currency-aware form');
 assert.match(dashboard,/ClassicFinMobileUnified\?\.initialise\(present\)/,
  'Changing deposit to withdrawal in dialog must recalculate the exchange');
 assert.match(layout,/mobile-money-unified\.js\?v=/,
  'Shared tenant layout loads the quote logic for dialogs on any page');
 assert.doesNotMatch(page,/script src="\/js\/mobile-money-unified\.js"/,
  'Avoid duplicate form initializers on the Mobile Money page');
});

test('Mobile Money overview visibly links the existing cashier form even before account setup',async()=>{
 const base=options();
 base.data.funds={wallets:[],paymentAccounts:[]};
 const html=await render('index',base);
 assert.match(html,/Record Mobile Money/);
 assert.match(html,/href="\/tenant\/mobile-money\/cash-in"/);
 assert.match(html,/href="\/tenant\/mobile-money\/cash-out"/);
 assert.match(html,/No ready wallet and assigned cash drawer pair/);
 assert.match(html,/Review real wallet and cash account assignments/);
});

test('cashier form displays real wallets and SSP-first authorized drawers without permitting other operators',async()=>{
 const base=options();
 base.data.funds={wallets:[
  {id:'own-wallet',name:'MTN wallet',kind:'wallet',network:'MTN',currency:'UGX',
   assignedToOperator:true,shared:false,state:'active',reconciliation:'matched',expectedMinor:'300000',isDefault:true},
  {id:'other-wallet',name:'Another cashier wallet',kind:'wallet',network:'MTN',currency:'UGX',
   assignedToOperator:false,shared:false,state:'active',reconciliation:'matched',expectedMinor:'900000'}
 ],paymentAccounts:[
  {id:'ugx-drawer',name:'UGX cash',kind:'cash',currency:'UGX',
   assignedToOperator:true,state:'active',reconciliation:'matched',expectedMinor:'120000'},
  {id:'ssp-drawer',name:'SSP cash',kind:'cash',currency:'SSP',
   assignedToOperator:true,state:'active',reconciliation:'matched',expectedMinor:'500000'},
  {id:'other-drawer',name:'Another cashier drawer',kind:'cash',currency:'SSP',
   assignedToOperator:false,state:'active',reconciliation:'matched',expectedMinor:'600000'}
 ]};
 base.data.operation='cash_out';
 const html=await render('entry',base);
 assert.match(html,/1\. Provider wallet and physical cash drawer/);
 assert.match(html,/option value="ssp-drawer"[^>]*selected/);
 assert.match(html,/option value="other-drawer"[^>]*disabled/);
 assert.match(html,/option value="other-wallet"[^>]*disabled/);
 assert.match(html,/assigned to another cashier/);
 const walletStart=html.indexOf('name="walletAccountId"');
 assert(walletStart>0 && walletStart<html.indexOf('name="networkReference"'),
  'Cashier needs to see the wallet first, before typing provider reference');
 assert.equal((html.match(/name="walletAccountId"/g)||[]).length,1);
 assert.equal((html.match(/name="paymentAccountId"/g)||[]).length,1);
});

test('recording permission warning states the live signed-in role without claiming a revocation',async()=>{
 const viewer=options();
 viewer.data.operation='cash_out';
 viewer.data.canRecord=false;
 viewer.user.role='Branch Manager';
 viewer.user.permissions=['mobile_money.view','treasury.view'];
 const html=await render('entry',viewer);
 assert.ok(html.includes('This signed-in session has role'));
 assert.ok(html.includes('<strong>Branch Manager</strong>'));
 assert.ok(html.includes('Deposit recording: <strong>Not allowed</strong>'));
 assert.ok(html.includes('Withdrawal recording: <strong>Not allowed</strong>'));
 assert.ok(!html.includes('An authorized tenant owner must assign the required recording permission'));
 assert.ok(!html.includes('data-mobile-money-form'));
 const oneAction=options();
 oneAction.data.operation='cash_out';
 oneAction.data.canRecord=false;
 oneAction.user.permissions=['mobile_money.view','mobile_money.cash_in'];
 const oneHtml=await render('entry',oneAction);
 assert.ok(oneHtml.includes('Open permitted Deposit'));
 assert.ok(oneHtml.includes('href="/tenant/mobile-money/cash-in"'));
});

test('tenant owner and assigned Mobile Money Operator retain their existing recording form',async()=>{
 for(const [role,permissions] of [
  ['Tenant Owner',['*']],
  ['Mobile Money Operator',['mobile_money.view','mobile_money.cash_in','mobile_money.cash_out']]
 ]){
  const local=options();
  local.user.role=role;
  local.user.permissions=permissions;
  local.data.canRecord=true;
  local.data.operation='cash_out';
  const html=await render('entry',local);
  assert.ok(html.includes('data-mobile-money-form'),role);
  assert.ok(html.includes('name="walletAccountId"'),role);
  assert.ok(!html.includes('This signed-in session has role'),role);
 }
});
