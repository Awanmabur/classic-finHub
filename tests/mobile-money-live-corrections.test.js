'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('MTN Uganda owner and transaction page use provider UGX, not unrelated branch USD',()=>{
 const routes=source('src/tenant/routes/mobileMoneyWorkspace.routes.js');
 const layout=source('src/views/layouts/dashboard.ejs');
 const entry=source('src/views/tenant/mobile-money/_entry-form.ejs');
 assert.match(routes,/branchCurrency\.resolve\(req\.operationBranch,selectedMarket\.currency\)/);
 assert.match(routes,/entryCurrency:operation\?mobileCurrency:null/);
 assert.match(layout,/mobileMarketDefault\|\|/);
 assert.match(layout,/mobileOperationPage/);
 assert.match(layout,/dashboardCurrencies\.length===1/);
 assert.match(entry,/class="control" type="text" readonly/);
 assert.doesNotMatch(entry,/class="networkReadOnly"/);
});

test('the existing real drawer is used by its assigned operator, never impersonated by Tenant Owner',()=>{
 const funds=source('src/tenant/services/mobileMoneyFunds.service.js');
 const js=source('public/js/dashboard.js');
 const entry=source('src/views/tenant/mobile-money/_entry-form.ejs');
 assert.match(funds,/operatorId:authorization\.actor\.id/);
 assert.match(funds,/wallet\.cashDrawerAccountId/);
 assert.match(funds,/eligible\.length!==1/);
 assert.match(funds,/do not create a duplicate cash drawer/);
 assert.match(js,/validAccounts\.length===0/);
 assert.match(js,/Sign in as the operator assigned to the physical drawer/);
 assert.match(entry,/data-momo-account-notice/);
 assert.match(js,/paymentField\.hidden=true/);
});

test('the two public provider tables can be quoted but never posted as agent income',()=>{
 const {quote,publicAgentReference}=require('../src/tenant/pricing/networkTariffs');
 const customer=require('../src/tenant/pricing/customerNetworkFees');
 const deposited=quote(publicAgentReference('cash_in'),'250000');
 assert.equal(deposited.status,'unverified_schedule_estimate');
 assert.equal(deposited.grossCommissionEstimateMinor,'500');
 assert.equal(deposited.postsToLedger,false);
 assert.equal(customer.quote('MTN','cash_in','250000').customerFeeMinor,'0');
 assert.equal(customer.quote('MTN','cash_out','250000').customerFeeMinor,'3575');
 const routes=source('src/tenant/routes/mobileMoneyWorkspace.routes.js');
 const quoteRoute=routes.slice(routes.indexOf("router.get('/quote'"),routes.indexOf("router.get('/onboarding'"));
 assert.match(quoteRoute,/source:'published_reference'/);
 assert.match(quoteRoute,/transactionEstimates/);
 assert.match(quoteRoute,/No additional customer charge, funds or income is posted/);
 assert.doesNotMatch(quoteRoute,/applyMovements|recordMobileMoney|\.create\(/);
});

test('provider estimates remain explicitly differentiated from independently approved tariff snapshots',()=>{
 const js=source('public/js/mobile-money-quote.js');
 const funds=source('src/tenant/services/mobileMoney.service.js');
 assert.match(js,/value\.source==='published_reference'/);
 assert.match(js,/reference only/);
 assert.match(funds,/networkTariffService'\)\.transactionEstimates/);
 assert.doesNotThrow(()=>new Function(js));
});
