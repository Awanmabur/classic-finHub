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
