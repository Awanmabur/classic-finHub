'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const path = require('node:path');
const {fromMinor} = require('../src/tenant/services/mobileMoney.service');
const views = path.resolve(__dirname,'../src/views/tenant/mobile-money');
const requestKey = '1b7db353-c630-4d62-b2c4-c396751ef77d';
const record = {_id:'507f1f77bcf86cd799439011',customer:'Customer <script>',customerPhone:'+256771234567',customerNote:'Receipt checked',network:'MTN',networkReference:'MTN-TEST1',operation:'cash_in',entrySource:'sms',currency:'UGX',amountMinor:'5000',feeMinor:'100',paymentMethod:'Cash',status:'pending_verification',reviewState:'awaiting_review',correctionState:'none',createdAt:new Date('2026-11-03T12:00:00Z')};
function options(overrides={}) {
  return {
    user:{id:'507f1f77bcf86cd799439012',role:'Mobile Money Operator',permissions:['mobile_money.view','mobile_money.cash_in','mobile_money.cash_out'],branchId:'aaaaaaaaaaaaaaaaaaaaaaaa'},
    operationBranch:{_id:'aaaaaaaaaaaaaaaaaaaaaaaa',name:'Assigned branch',currency:'UGX',status:'active'},
    csrfToken:'protected-csrf',money:(currency,amount)=>`${currency} ${amount}`,amountFromMinor:fromMinor,
    data:{operation:'cash_in',canRecord:true,canExport:true,idempotencyKey:requestKey,filters:{from:'2026-11-03',to:'2026-11-03',network:'MTN',currency:'UGX',entrySource:'sms'},records:{items:[record],nextCursor:'next-key'},networksAvailable:['MTN','Airtel','Africell','M-Pesa'],currencies:['UGX','USD','SSP','KES'],networks:[{network:'MTN',currency:'UGX',cashInCount:1,cashOutCount:0,formatted:{volume:'UGX 5,000',fees:'UGX 100'}}],summary:{total:1,activeCount:1,manualCount:0,smsCount:1,voidedCount:0,byCurrency:[{currency:'UGX',count:1,cashInCount:1,cashOutCount:0,physicalCashInCount:1,physicalCashOutCount:0,formatted:{cashIn:'UGX 5,000',cashOut:'UGX 0',physicalCashIn:'UGX 5,000',physicalCashOut:'UGX 0',cashImpact:'UGX 5,000',volume:'UGX 5,000',fees:'UGX 100'}}]}},
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
  for(const label of ['Customer and network','Customer phone','Customer name','Network transaction reference','Customer ID / note','Amount details','Fee / commission','Payment method','Physical cash received from customer','Record deposit']) assert.ok(html.includes(label),label);
  assert.match(html,/<option value="Africell" data-market-currency=""(?: selected| disabled)*>Africell<\/option>/);
  assert.match(html,/<option value="Wallet Balance">Wallet Balance<\/option>/);
  assert.match(html,/<option value="Bank">Bank<\/option>/);
  const currency = html.match(/<select\b[^>]*name="currency"[^>]*>([\s\S]*?)<\/select>/);
  assert(currency,'Approved currency control must be present');
  assert.deepEqual([...currency[1].matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(match=>match[1]),['UGX','USD','SSP','KES']);
  assert.match(html,/Assigned branch/);
  const transactionForm = html.match(/<form[^>]+data-mobile-money-form[\s\S]*?<\/form>/)[0];
  assert.doesNotMatch(transactionForm,/<(?:select|input)[^>]+name="branchId"/);
  assert.doesNotMatch(html,/name="branchId"/);
  assert.match(html,/Saved records and verification status/);
  assert.match(html,/pending verification/);
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
  assert.match(network,/pending verification/);
  assert.match(network,/network=MTN/);
  assert.match(network,/entrySource=sms/);
  assert.match(network,/cursor=next-key/);
  const report = await render('report',options());
  for(const label of ['Mobile tx','Mobile volume','Cash impact','Manual records','SMS capture records','Voided originals']) assert.ok(report.includes(label));
  assert.match(report,/\/tenant\/mobile-money\/report\/export\.csv\?/);
  const readonly = options(); readonly.data.canExport=false;
  assert.doesNotMatch(await render('report',readonly),/Export CSV/);
});

test('cash impact retains all approved cards and separates physical cash from recorded commissions',async()=>{
  const html = await render('cash-impact',options());
  for(const label of ['Deposit','Withdrawal','Net impact','Fee / commission recorded']) assert.ok(html.includes(label));
  assert.match(html,/Cash-method cash-in minus Cash-method cash-out/);
  assert.match(html,/Bank and Wallet Balance records are excluded/);
  const empty = options(); empty.data.summary.byCurrency=[]; empty.data.records={items:[]};
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
 context.data.funds={wallets:[{id:'wa',name:'MTN South Sudan float',kind:'wallet',network:'MTN SSD',currency:'SSP',expected:'SSP 250.00',reconciliation:'matched'}],paymentAccounts:[{id:'ca',name:'Agent drawer',kind:'cash',network:'',currency:'SSP',expected:'SSP 550.00',reconciliation:'matched'}],customerAccounts:[]};
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
  paymentAccounts:[{id:'cash1',kind:'cash',name:'Assigned cash drawer',currency:'UGX',expected:'UGX 120,000',reconciliation:'matched'}],
  wallets:[{id:'float1',kind:'wallet',name:'MTN Uganda wallet',network:'MTN',currency:'UGX',expected:'UGX 450,000',reconciliation:'matched'}],
  customerAccounts:[]
 };
 locals.data.reviewQueue=[];locals.data.voidQueue=[];locals.data.records=[];
 const html=await render('index',locals);
 for(const label of ['Cash and float balances','UGX 120,000','UGX 450,000','Physical cash','Electronic float','Assigned cash drawer','MTN Uganda wallet'])assert.ok(html.includes(label),label);
 assert.match(html,/\/css\/workspace\.css\?v=/);
 assert.doesNotMatch(html,/Cash-in<\/a>|Cash-out<\/a>/);
});
test('Mobile Money entry and filters keep deposit and withdrawal labels, not cash-in/out labels',async()=>{
 const locals=options();
 const entry=await render('entry',locals);
 assert.match(entry,/\/css\/workspace\.css\?v=/);
 const filters=require('node:fs').readFileSync(path.join(views,'_filters.ejs'),'utf8');
 assert.match(filters,/>Deposit<\/option>/);
 assert.match(filters,/>Withdrawal<\/option>/);
 assert.doesNotMatch(filters,/>Cash-in<\/option>|>Cash-out<\/option>/);
});
