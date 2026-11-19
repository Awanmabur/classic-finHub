'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {markets,preferred,withDefaultFilters,cashForMarket}=require('../src/tenant/services/mobileMoneyMarket.service');
const file=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const wallet=(network,currency,extra={})=>({network,currency,state:'active',
 reconciliation:'matched',expectedMinor:'200000',...extra});
test('only approved real wallets create a Mobile Money default; MTN Uganda wins over other markets',()=>{
 const list=[wallet('MTN SSD','SSP'),wallet('Airtel','UGX'),
   wallet('MTN','UGX',{expectedMinor:null}),wallet('MTN','UGX'),wallet('Africell','USD',{state:'held'})];
 assert.deepEqual(markets(list).map(m=>m.network+' '+m.currency),['MTN UGX','Airtel UGX','MTN SSD SSP']);
 assert.deepEqual(preferred(list),{network:'MTN',currency:'UGX',label:'MTN MoMo Uganda'});
 assert.deepEqual(withDefaultFilters({},list),{network:'MTN',currency:'UGX'});
 assert.deepEqual(withDefaultFilters({network:'MTN SSD'},list),{network:'MTN SSD',currency:'SSP'});
 assert.deepEqual(withDefaultFilters({network:'',currency:''},list),{network:'',currency:''});
 assert.deepEqual(withDefaultFilters({network:''},list),{network:'',currency:''});
});
test('market has only one network and no invented extra USD currency',()=>{
 const list=[wallet('MTN','UGX')];
 assert.deepEqual(markets(list).map(m=>m.currency),['UGX']);
 assert.equal(withDefaultFilters({},list).network,'MTN');
 assert.deepEqual(markets([wallet('MTN','USD')]),[],'MTN Uganda cannot be advertised with USD');
 assert.equal(preferred([wallet('MTN','UGX',{reconciliation:'mismatch'})]),null);
});
test('cash-drawer association is configured once by owner and enforced in funds ledger',()=>{
 const schema=file('src/tenant/treasury/models.js');
 const config=file('src/tenant/treasury/service.js');
 const funds=file('src/tenant/services/mobileMoneyFunds.service.js');
 const view=file('src/views/tenant/treasury/detail.ejs');
 const form=['_funds-context.ejs','_funds-wallet-account.ejs','_funds-cash-account.ejs']
  .map(name=>file('src/views/tenant/mobile-money/'+name)).join('\n');
 const scripts=file('public/js/dashboard.js');
 assert.match(schema,/cashDrawerAccountId/);
 assert.match(config,/account\.operatorId&&String\(drawer\.operatorId\)/);
 assert.match(config,/status:'active',reconciliationState:'matched'/);
 assert.match(funds,/wallet\.cashDrawerAccountId/);
 assert.match(funds,/values\.paymentAccountId&&String\(values\.paymentAccountId\)/);
 assert.match(view,/name="cashDrawerAccountId"/);
 assert.match(form,/data-cash-drawer/);
 assert.match(scripts,/paymentField.hidden=true/);
 assert.match(form,/<label class="field" data-payment-account-field/);
 assert.match(form,/preferredSSP/);
 assert.match(form,/name="paymentAccountId"/);
 assert.match(file('public/js/mobile-money-unified.js'),/cashAccountId/);
});

test('dashboard does not attribute Airtel or shared branch cash to MTN without explicit mapping',()=>{
 const a={id:'drawer-mtn',kind:'cash',currency:'UGX'};
 const b={id:'drawer-airtel',kind:'cash',currency:'UGX'};
 const market={network:'MTN',currency:'UGX'};
 const single=cashForMarket({paymentAccounts:[a],wallets:[wallet('MTN','UGX')]},market);
 assert.equal(single.accounts.length,1);
 assert.equal(single.requiresMapping,false);
 const unmapped=cashForMarket({paymentAccounts:[a,b],wallets:[wallet('MTN','UGX')]},market);
 assert.deepEqual(unmapped.accounts,[]);
 assert.equal(unmapped.requiresMapping,true);
 const mapped=cashForMarket({paymentAccounts:[a,b],wallets:[wallet('MTN','UGX',{cashDrawerAccountId:'drawer-mtn'})]},market);
 assert.deepEqual(mapped.accounts.map(x=>x.id),['drawer-mtn']);
 assert.equal(mapped.requiresMapping,false);
});
