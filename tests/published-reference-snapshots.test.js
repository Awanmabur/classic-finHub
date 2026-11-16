'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const published=require('../src/tenant/pricing/publishedReference.service');
const model=require('../src/tenant/pricing/publishedReferenceSnapshot').schema;
const src=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');

test('published MTN agent commission and customer charges remain reference-only snapshots',()=>{
 const at=new Date('2026-11-16T13:00:00Z');
 const quote=published.quote({network:'MTN',currency:'UGX',operation:'cash_in',amountMinor:'250000',at});
 assert.equal(quote.agentCommissionPublishedReference.amountMinor,'500');
 assert.equal(quote.agentCommissionPublishedReference.status,'reference_only');
 assert.equal(quote.agentCommissionPublishedReference.checkedOn,'2026-11-14');
 assert.equal(quote.customerNetworkChargePublishedReference.amountMinor,'0');
 assert.equal(quote.customerNetworkChargePublishedReference.status,'reference_only');
 assert.equal(quote.agentCommissionPublishedReference.quotedAt.getTime(),at.getTime());
 assert.match(quote.agentCommissionPublishedReference.sourceUrl,/^https:\/\//);
 assert.equal(model.path('amountMinor').options.immutable,true);
});
test('Airtel historical customer fee is explicitly unverified while unknown markets produce no reference',()=>{
 const airtel=published.quote({network:'Airtel',currency:'UGX',operation:'cash_out',amountMinor:'250000'});
 assert.equal(airtel.customerNetworkChargePublishedReference.amountMinor,'3575');
 assert.equal(airtel.customerNetworkChargePublishedReference.status,'historical_unverified');
 assert.equal(airtel.agentCommissionPublishedReference,null);
 const juba=published.quote({network:'MTN SSD',currency:'SSP',operation:'cash_out',amountMinor:'250000'});
 assert.equal(juba.agentCommissionPublishedReference,null);
 assert.equal(juba.customerNetworkChargePublishedReference,null);
 const wrongCurrency=published.quote({network:'MTN',currency:'SSP',operation:'cash_in',amountMinor:'250000'});
 assert.equal(wrongCurrency.agentCommissionPublishedReference,null);
});
test('published evidence is kept distinct from tenant-approved snapshots and cannot post money',()=>{
 const transactions=src('src/tenant/services/mobileMoney.service.js');
 const moneyModel=src('src/tenant/models/index.js');
 const csv=src('src/tenant/services/mobileMoneyWorkspace.service.js');
 assert.match(transactions,/publishedReference\.service'\)\.quote\(/);
 assert.match(moneyModel,/agentCommissionPublishedReference/);
 assert.match(moneyModel,/customerNetworkChargePublishedReference/);
 assert.match(csv,/Published agent commission reference \(unapproved\)/);
 assert.doesNotMatch(src('src/tenant/pricing/publishedReference.service.js'),/applyMovements|create\(|ledgerLines|commissionPayout/);
});
