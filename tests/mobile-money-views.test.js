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
  for(const label of ['Customer and network','Customer phone','Customer name','Network transaction reference','Customer ID / note','Amount details','Fee / commission','Payment method','Physical cash received from customer','Process mobile money']) assert.ok(html.includes(label),label);
  assert.match(html,/<option value="Africell">Africell<\/option>/);
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
 assert.match(html,/value="MTN SSD">MTN SSD<\/option>/);assert.match(html,/pattern="\[0-9\]\{1,11\}\(\[\.\]\[0-9\]\{1,2\}\)\?"/);
});

test('cash-out has its own protected action and tabs respect exact operation permissions',async()=>{
  const locals = options(); locals.data.operation='cash_out'; locals.user.permissions=['mobile_money.view','mobile_money.cash_out'];
  const html = await render('entry',locals);
  assert.match(html,/action="\/tenant\/mobile-money\/cash-out"/);
  assert.match(html,/Mobile Money - Customer withdrawal \\(Cash-out\\)/);
  assert.match(html,/data-mobile-operation="cash_out"/);
  assert.doesNotMatch(html,/data-mobile-operation="cash_in"/);
  locals.data.canRecord=false;
  const readonly = await render('entry',locals);
  assert.doesNotMatch(readonly,/data-mobile-money-form/);
  assert.doesNotMatch(readonly,/Process mobile money/);
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
  for(const label of ['Cash-in','Cash-out','Net impact','Fee / commission recorded']) assert.ok(html.includes(label));
  assert.match(html,/Cash-method cash-in minus Cash-method cash-out/);
  assert.match(html,/Bank and Wallet Balance records are excluded/);
  const empty = options(); empty.data.summary.byCurrency=[]; empty.data.records={items:[]};
  const emptyHtml = await render('cash-impact',empty);
  assert.match(emptyHtml,/<div class="k">Cash-in<\/div>/);
  assert.match(emptyHtml,/<div class="k">Cash-out<\/div>/);
  assert.match(emptyHtml,/<div class="k">Net impact<\/div>/);
});
