'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {NETWORKS,publicAgentReference,validateTariff,quote}=require('../src/tenant/pricing/networkTariffs');

test('MTN South Sudan remains a distinct SSP provider, not an alias of Uganda',()=>{
 assert.equal(NETWORKS['MTN SSD'].currency,'SSP');
 assert.equal(NETWORKS.MTN.currency,'UGX');
 assert.notEqual(NETWORKS['MTN SSD'].country,NETWORKS.MTN.country);
});
test('published Uganda agent reference is only an estimate, never auto-posted income',()=>{
 const deposit=publicAgentReference('cash_in'),withdraw=publicAgentReference('cash_out');
 assert.equal(validateTariff(deposit),true);
 assert.equal(quote(deposit,'2000').grossCommissionEstimateMinor,'80');
 assert.equal(quote(deposit,'3000').grossCommissionEstimateMinor,'110');
 assert.equal(quote(withdraw,'3000').grossCommissionEstimateMinor,'120');
 assert.equal(quote(withdraw,'45000').grossCommissionEstimateMinor,'360');
 assert.equal(quote(withdraw,'7000000').grossCommissionEstimateMinor,'5000');
 assert.equal(quote(withdraw,'7000001').status,'no_matching_band');
 assert.equal(quote(deposit,'2000').postsToLedger,false);
 assert.equal(quote(deposit,'2000').requiresProviderSettlement,true);
 assert.equal(quote(deposit,'2000').status,'unverified_schedule_estimate');
});
test('invalid, overlapping, cross-currency or self-declared verified tariffs are rejected',()=>{
 const base=publicAgentReference('cash_in');
 for(const bad of [
  {...base,network:'MTN SSD'},
  {...base,status:'verified'},
  {...base,tiers:[]},
  {...base,tiers:[base.tiers[0],{...base.tiers[0]}]},
  {...base,tiers:[{minMinor:'1',maxMinor:'50',rate:{kind:'basis_points',value:'10001'}}]},
  {...base,tiers:[{minMinor:'1',maxMinor:'50',rate:{kind:'flat',value:'1.5'}}]}
 ])assert.throws(()=>validateTariff(bad));
});
test('rate is calculated with integer math and exact boundary selection',()=>{
 const b={network:'MTN SSD',currency:'SSP',operation:'cash_in',status:'draft',tiers:[
  {minMinor:'1',maxMinor:'9999',rate:{kind:'basis_points',value:'125'}}
 ]};
 assert.equal(quote(b,'199').grossCommissionEstimateMinor,'2');
 assert.equal(quote(b,'200').grossCommissionEstimateMinor,'3');
 assert.equal(quote(b,'10000').status,'no_matching_band');
 assert.equal(quote(b,'9999').grossCommissionEstimateMinor,'125');
});
