'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');
const payout=require('../src/tenant/pricing/commissionPayoutService');
const root=path.join(__dirname,'..');

function recentUtc(){
 const d=new Date(Date.now()-60000);
 return d.toISOString().slice(0,16);
}
const base=()=>({
 network:'MTN SSD',currency:'SSP',walletAccountId:'507f1f77bcf86cd799439011',
 amount:'102.25',grossAmount:'102.25',taxWithheld:'0',providerCost:'0',providerReference:'MOMO-COMM-REF-123456',
 statementEvidence:'Official commission line provider statement, ref 123456',
 creditedAt:recentUtc()
});
test('commission evidence validates exact SSP amount, network and unique trace reference',()=>{
 const result=payout.validate(base());
 assert.equal(result.amountMinor,'10225');
 assert.equal(result.grossMinor,'10225');
 assert.equal(result.currency,'SSP');
 assert.equal(result.network,'MTN SSD');
 assert.equal(result.providerReference,'MOMO-COMM-REF-123456');
});
test('network payout rejects negative, mismatched currency, invalid dates and unknown provider',()=>{
 for(const v of [
  {...base(),network:'MTN'}, {...base(),currency:'UGX'},
  {...base(),network:'Unknown Provider'},{...base(),amount:'-1'},
  {...base(),amount:'2.999'}, {...base(),amount:'0'},
  {...base(),providerReference:'***'},
  {...base(),statementEvidence:'short'},
  {...base(),creditedAt:'2020-01-01T10:00'},
  {...base(),walletAccountId:'garbage'},
  {...base(),unexpectedField:'x'}
 ])assert.throws(()=>payout.validate(v));
});
test('commission posting is explicitly gated and ties to immutable treasury movements',()=>{
 const service=fs.readFileSync(path.join(root,'src/tenant/pricing/commissionPayoutService.js'),'utf8');
 const schema=fs.readFileSync(path.join(root,'src/tenant/pricing/commissionPayoutModels.js'),'utf8');
 assert.match(service,/ENABLE_MOMO_COMMISSION_POSTING/);
 assert.match(service,/process\.env\.ENABLE_MOMO_COMMISSION_POSTING!=='true'/);
 assert.match(service,/sourceRef:'MCOM:'\+String\(prior\._id\)/);
 assert.match(service,/treasury\.applyMovements\(/);
 assert.match(service,/posting\.duplicate/);
 assert.match(service,/posting\.journalIds\.length===0/);
 assert.match(service,/!posting\?\.batch\?\._id/);
 assert.match(service,/purpose:'agent_commission_income'/);
 assert.match(service,/String\(prior\.createdBy\)===auth\.actor\.id/);
 assert.match(schema,/providerReference:1\},\{unique:true\}/);
});
test('payout UI discloses lock and never offers a live approval while locked',async()=>{
 const d={schedules:[],customerTariffReferences:require('../src/tenant/pricing/customerNetworkFees').TABLES,commissions:{records:[{
  _id:'507f1f77bcf86cd799439022',network:'MTN SSD',currency:'SSP',amountMinor:'1250',
  providerReference:'REF-TEST',statementEvidence:'Statement ref 123',creditedAt:new Date(),
  status:'pending_review'
 }],wallets:[{_id:'507f1f77bcf86cd799439011',name:'Commission float',currency:'SSP',network:'MTN SSD'}]},
 branches:[],providerChoices:[{key:'MTN SSD',displayName:'MTN MoMo South Sudan',currency:'SSP'}],
 canPropose:false,canReview:false,canSubmitPayout:true,canReviewPayout:true,postingEnabled:false,
 serializeLines:()=>'',formatMinor:(amount,currency)=>currency+' '+(Number(amount)/100).toFixed(2)};
 const html=await ejs.renderFile(path.join(root,'src/views/tenant/mobile-money/tariffs.ejs'),{
  data:d,csrfToken:'test-csrf',assetVersion:'test'
 });
 assert.match(html,/Posting locked/);
 assert.match(html,/name="statementEvidence"/);
 assert.match(html,/name="_csrf" value="test-csrf"/);
 assert.doesNotMatch(html,/>Approve and post</);
 assert.match(html,/>Reject evidence</);
});

test('additional market commission evidence can be entered only with matching receiving wallet at service layer',()=>{
 const valid=payout.validate({...base(),network:'Africell'});
 assert.equal(valid.network,'Africell');
 assert.equal(valid.currency,'SSP');
 const source=fs.readFileSync(path.join(root,'src/tenant/pricing/commissionPayoutService.js'),'utf8');
 assert.match(source,/wallet\.network!==values\.network/);
 assert.match(source,/wallet\.currency!==values\.currency/);
 assert.match(source,/wallet\.reconciliationState!=='matched'/);
});
