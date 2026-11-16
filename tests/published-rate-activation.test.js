'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {templates}=require('../src/tenant/pricing/publishedRateActivation');
const {preview}=require('../src/tenant/pricing/networkTariffService');
const {quote}=require('../src/tenant/pricing/customerNetworkFees');
const {quote:publishedQuote}=require('../src/tenant/pricing/publishedReference.service');
function amount(schedule,minor){return preview(schedule,String(minor)).customerNetworkChargeEstimateMinor;}
test('Existing MTN fee sheet activates as two full rate schedules without hand-entered values',()=>{
 const rows=templates('MTN','customer_network_fee');
 assert.deepEqual(rows.map(r=>r.operation),['cash_in','cash_out']);
 assert.equal(rows[0].scheduleKind,'customer_network_fee');
 assert.equal(rows[0].tiers[0].rate.value,'0');
 const out=rows[1];
 for(const amountMinor of ['500','2500','2501','60000','60001','100000','125000','125001','250000','250001','500000','500001','5000000']){
  assert.equal(amount(out,amountMinor),quote('MTN','cash_out',amountMinor).customerFeeMinor);
 }
 assert.equal(amount(out,100000),'1925');
 assert.equal(amount(out,500000),'7000');
 assert.equal(amount(out,125001),'3575');
 assert.equal(preview(out,'100').status,'no_matching_band');
 assert.equal(rows.every(r=>r.sourceStatus==='published_reference'),true);
});
test('Existing MTN agent commission bands are imported separately from network customer fees',()=>{
 const rows=templates('MTN','agent_commission');
 assert.deepEqual(rows.map(r=>r.operation),['cash_in','cash_out']);
 assert.equal(preview(rows[0],'2000').grossCommissionEstimateMinor,'80');
 assert.equal(preview(rows[1],'3000').grossCommissionEstimateMinor,'120');
 assert.equal(rows.every(r=>r.scheduleKind==='agent_commission'),true);
});
test('Airtel historical provider sheet is readable for reference but not approved as current',()=>{
 assert.throws(()=>templates('Airtel','customer_network_fee'),/historical\/unverified/);
 assert.throws(()=>templates('Airtel','agent_commission'));
 const reference=publishedQuote({network:'Airtel',currency:'UGX',operation:'cash_out',amountMinor:'100000'});
 assert.equal(reference.customerNetworkChargePublishedReference.amountMinor,'1925');
 assert.equal(reference.customerNetworkChargePublishedReference.status,'historical_unverified');
 assert.equal(reference.agentCommissionPublishedReference,null);
 assert.throws(()=>templates('MTN SSD','customer_network_fee'));
});

test('Only the tenant owner can activate the built-in sheet; the UI submits no bands or fee amounts',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const src=part=>fs.readFileSync(path.join(__dirname,'..',part),'utf8');
 const routes=src('src/tenant/routes/mobileMoneyTariffs.routes.js');
 const service=src('src/tenant/pricing/networkTariffService.js');
 const view=src('src/views/tenant/mobile-money/tariffs.ejs');
 assert.match(routes,/router\.post\('\/published\/activate',requirePermission\('treasury\.review'\)/);
 assert.match(service,/auth\.actor\.role!=='Tenant Owner'/);
 assert.match(service,/providerConfirmed:false/);
 assert.match(service,/permission:'treasury\.review',sourceType:'mobile_money',session,fence:true/);
 assert.match(view,/Approve these existing fees for estimates/);
 assert.match(view,/name="scheduleKind" value="customer_network_fee"/);
 assert.match(view,/name="scheduleKind" value="agent_commission"/);
 const schema=require('../src/tenant/pricing/networkTariffModels').schema;
 assert.equal(schema.path('sourceKind').options.immutable,true);
 assert.equal(schema.path('providerConfirmed').options.default,false);
});
