'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const source=file=>fs.readFileSync(path.join(root,file),'utf8');

test('additional genuine regional network identities are configurable but not silently SMS-integrated',()=>{
 const {networks,smsNetworks}=require('../src/config/mobileNetworks');
 const {NETWORKS}=require('../src/tenant/pricing/networkTariffs');
 for(const key of ['mGURUSH','Digi Cash']){
  assert(networks.includes(key));
  assert.equal(NETWORKS[key].country,'SS');
  assert.equal(NETWORKS[key].currency,null,'currency is selected from a verified agent wallet');
  assert(!smsNetworks.includes(key),'unsupported SMS detection is not claimed as integrated');
 }
 const entry=source('src/views/tenant/mobile-money/_entry-form.ejs');
 assert.match(entry,/entryNeedsWallet/);
 assert.match(entry,/entryVerifiedMarket/);
 const service=source('src/tenant/services/mobileMoney.service.js');
 assert.match(service,/Configure an independently approved provider float wallet before recording/);
});

test('agent transaction shows confirmed-rate estimates separately from configured customer fee',()=>{
 const template=source('src/views/tenant/mobile-money/_entry-form.ejs');
 const quoteJs=source('public/js/mobile-money-quote.js');
 assert.match(template,/data-mobile-provider-quote/);
 assert.match(template,/data-mobile-agent-commission/);
 assert.match(template,/data-mobile-provider-charge/);
 assert.match(template,/include\('\.\.\/partials\/operation-pricing'/);
 assert.match(quoteJs,/\/tenant\/mobile-money\/quote/);
 assert.match(quoteJs,/const hasCommission=Boolean\(data\.agentCommission\?\.amount\)/);
 assert.match(quoteJs,/area\.hidden=true/);
 assert.doesNotThrow(()=>new Function(quoteJs));
 const routes=source('src/tenant/routes/mobileMoneyWorkspace.routes.js');
 const quote=routes.slice(routes.indexOf("router.get('/quote'"),routes.indexOf("router.get('/cash-in'"));
 assert.match(quote,/transactionEstimates/);
 assert.match(quote,/Cache-Control','private, no-store'/);
 assert.doesNotMatch(quote,/recordMobileMoney|applyMovements|\.create\(/);
});

test('agent form selects authorized cash and provider float without customer wallet/bank entry',()=>{
 const form=source('src/views/tenant/mobile-money/_entry-form.ejs');
 const template=source('src/views/tenant/mobile-money/_funds-context.ejs');
 const scripts=source('public/js/dashboard.js');
 const service=source('src/tenant/services/mobileMoney.service.js');
 assert.match(form,/name="paymentMethod" value="Cash"/);
 assert.doesNotMatch(form,/value="Wallet Balance"/);
 assert.doesNotMatch(form,/value="Bank"/);
 assert.match(template,/data-wallet-account-field/);
 assert.match(template,/data-payment-account-field/);
 assert.doesNotMatch(template,/data-customer-wallet/);
 assert.match(template,/assignedToOperator/);
 assert.match(scripts,/paymentField.hidden=true/);
 assert.match(scripts,/configuredDrawer=wallet.selectedOptions/);
 assert.match(template,/data-cash-drawer/);
 assert.match(scripts,/walletField.hidden=available.length===1/);
 assert.match(service,/options.requireFunds===true && values.paymentMethod!=='Cash'/);
});

test('financial readiness diagnostic is read-only and scoped to the operating branch',()=>{
 const routes=source('src/tenant/routes/mobileMoneyWorkspace.routes.js');
 const diagnosis=routes.slice(routes.indexOf("router.get('/readiness'"),routes.indexOf("router.get('/quote'"));
 assert.match(diagnosis,/branchId:req\.operationBranch\._id/);
 assert.match(diagnosis,/tenantId:req\.tenant\._id/);
 assert.match(diagnosis,/untrackedHistoricalOperationsPresent/);
 assert.match(diagnosis,/operatorId:req\.user\.id/);
 assert.match(diagnosis,/res\.json/);
 assert.doesNotMatch(diagnosis,/\.update|\.create|applyMovements/);
});

test('cash opening remains a real audited and independently reviewed action',()=>{
 const template=source('src/views/tenant/mobile-money/shifts.ejs');
 const routes=source('src/tenant/routes/cashControl.routes.js');
 const main=source('src/views/tenant/dashboard/index.ejs');
 assert.match(template,/name="openingCash"/);
 assert.match(template,/action="\/tenant\/day\/open"/);
 assert.match(routes,/router\.post\('\/day\/open'/);
 assert.match(main,/visiblePaths\.has\('\/tenant\/cash\/shifts'\)/);
 assert.match(main,/href="<%= opener\.href %>"/);
 assert.match(main,/id="openDayBtn"/);
});

test('standalone EJS operation partial never requires dashboard-only assetVersion local',()=>{
 const entry=source('src/views/tenant/mobile-money/_entry-form.ejs');
 const layout=source('src/views/layouts/dashboard.ejs');
 assert.doesNotMatch(entry,/<script[^>]+mobile-money-quote\.js/);
 assert.match(layout,/\/js\/mobile-money-quote\.js\?v=<%= assetVersion %>/);
});
