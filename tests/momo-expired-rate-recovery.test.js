'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=rel=>fs.readFileSync(path.join(__dirname,'..',rel),'utf8');
const {inputRate,canManageRate}=require('../src/tenant/services/mobileMoneyFxRate.service');
const {permissionsFor}=require('../src/config/roles');

test('Mobile Money deposit defaults Sell and explicitly displays rate lifetime',()=>{
 const page=source('src/views/tenant/mobile-money/entry.ejs');
 assert.match(page,/<option value="sell" <%= data\.operation==='cash_in'\?'selected':'' %>>Sell/);
 assert.match(page,/<option value="buy" <%= data\.operation==='cash_out'\?'selected':'' %>>Buy/);
 for(const hours of ['24','48','72'])assert(page.includes('<option value="'+hours+'"'));
 assert.match(page,/Cross-currency rate expired:/);
 assert.match(page,/data\.fxState\.expiredRates/);
});
test('Owner and persisted branch manager may renew an approved operating rate within role policy',()=>{
 assert.equal(canManageRate({role:'Tenant Owner',permissions:['*']}),true);
 assert.equal(canManageRate({role:'Branch Manager',permissions:permissionsFor('Branch Manager')}),true);
 assert.equal(canManageRate({role:'Mobile Money Operator',permissions:permissionsFor('Mobile Money Operator')}),false);
 assert.equal(canManageRate({role:'Branch Manager',permissions:['treasury.manage','mobile_money.view']}),false);
 assert.equal(canManageRate({role:'Reconciliation Officer',permissions:['*']}),false);
});
test('Rate renewal requires a positive owner/manager-supplied quote and finite explicit validity',()=>{
 const body={fromCurrency:'UGX',toCurrency:'SSP',side:'sell',rateBaseUnits:'1000',quotedRate:'1000',validHours:'72'};
 assert.equal(inputRate(body).rateDecimal,'1');
 assert.equal(inputRate(body).validHours,72);
 assert.throws(()=>inputRate({...body,validHours:'73'}),/validity/);
 assert.throws(()=>inputRate({...body,side:'buy',quotedRate:'0'}),/greater than zero/);
});
test('Missing and expired rates are different errors and never bypass financial settlement checks',()=>{
 const preview=source('src/tenant/services/momoFxPreview.service.js');
 assert.match(preview,/previous\?\.expiresAt/);
 assert.match(preview,/expired\. No amounts were posted/);
 assert.match(preview,/No approved/);
 assert.match(preview,/expiresAt:\{\$gt:now\}/);
 const settlement=source('src/tenant/services/momoFxSettlement.service.js');
 assert.match(settlement,/expiresAt:\{\$gt:new Date\(\)\}/);
});
