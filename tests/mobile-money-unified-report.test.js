'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const reporting=require('../src/tenant/services/mobileMoneyUnifiedReport.service');
test('daily weekly monthly quarterly and annual windows are UTC and have explicit inclusive end dates',()=>{
 const now=new Date('2026-11-16T12:30:00Z');
 const expected={
  today:['2026-11-16','2026-11-16'],
  week:['2026-11-16','2026-11-22'],
  month:['2026-11-01','2026-11-30'],
  quarter:['2026-10-01','2026-12-31'],
  year:['2026-01-01','2026-12-31']
 };
 for(const [period,[from,to]] of Object.entries(expected)){
  const window=reporting.periodWindow({period},now);
  assert.equal(window.from,from);
  assert.equal(window.to,to);
  assert.equal(window.bounds.$lt.toISOString().slice(0,10),new Date(Date.parse(to+'T00:00:00Z')+86400000).toISOString().slice(0,10));
 }
 assert.equal(reporting.periodWindow({from:'2026-03-01',to:'2026-03-15'},now).key,'custom');
 assert.throws(()=>reporting.periodWindow({period:'custom',from:'2026-12-01',to:'2026-11-01'}));
 assert.throws(()=>reporting.periodWindow({period:'custom',from:'2024-01-01',to:'2026-01-01'}));
 assert.throws(()=>reporting.periodWindow({period:'custom',from:'2026-02-30',to:'2026-03-01'}));
});
test('by-network and currency report keeps volume, collected fees, estimates and paid commissions separate',()=>{
 const transactions=[
  {_id:{network:'MTN',currency:'UGX',operation:'cash_in',entrySource:'manual',feeTreatment:'record_only',status:'pending_verification',reviewState:'awaiting_review',voided:false},
   count:1,amountMinor:'250000',feeMinor:'200',cashMovementMinor:'250000',estimatedCommissionMinor:'500'},
  {_id:{network:'MTN',currency:'UGX',operation:'cash_out',entrySource:'sms',feeTreatment:'payment_collected',status:'pending_verification',reviewState:'accepted',voided:false},
   count:1,amountMinor:'100000',feeMinor:'1000',cashMovementMinor:'-99000',estimatedCommissionMinor:'600'},
  {_id:{network:'Airtel',currency:'UGX',operation:'cash_in',entrySource:'manual',feeTreatment:'record_only',status:'voided_internal',reviewState:'awaiting_review',voided:true},
   count:1,amountMinor:'900000',feeMinor:'80000',cashMovementMinor:'900000',estimatedCommissionMinor:'1000'},
  {_id:{network:'MTN SSD',currency:'SSP',operation:'cash_in',entrySource:'sms',feeTreatment:'record_only',status:'pending_verification',reviewState:'accepted',voided:false},
   count:1,amountMinor:'1000',feeMinor:'0',cashMovementMinor:'1000',estimatedCommissionMinor:'0'}
 ];
 const payouts=[{_id:{network:'MTN',currency:'UGX'},amountMinor:'700',grossMinor:'700',taxMinor:'0',costMinor:'0'}];
 const expenses=[{_id:{currency:'UGX'},count:2,amountMinor:'1500'}];
 const result=reporting.summarize(transactions,payouts,expenses);
 assert.equal(result.currencies.length,2);
 const ug=result.currencies.find(x=>x.currency==='UGX');
 assert.equal(ug.volumeMinor,350000n);
 assert.equal(ug.cashImpactMinor,151000n);
 assert.equal(ug.recordedFeeMinor,1200n);
 assert.equal(ug.collectedFeeMinor,1000n);
 assert.equal(ug.estimatedCommissionMinor,1100n);
 assert.equal(ug.receivedCommissionMinor,700n);
 assert.equal(ug.voidedCount,1);
 assert.equal(ug.pendingReviewCount,1);
 assert.equal(result.expenses[0].amountMinor,'1500');
 assert.equal(result.networks.find(x=>x.network==='Airtel').volumeMinor,0n);
 assert.equal(result.currencies.find(x=>x.currency==='SSP').volumeMinor,1000n);
});
test('legacy wallet commissions are flagged but not combined into actual provider payout',()=>{
 const result=reporting.summarize([{
  _id:{network:'MTN',currency:'UGX',operation:'cash_in',entrySource:'manual',feeTreatment:'wallet_commission',status:'pending_verification',reviewState:'accepted',voided:false},
  count:1,amountMinor:'10000',feeMinor:'400',cashMovementMinor:'10000',estimatedCommissionMinor:'400'
 }],[],[]);
 assert.equal(result.currencies[0].legacyWalletFeeMinor,400n);
 assert.equal(result.currencies[0].receivedCommissionMinor,0n);
});

test('published provider fee-sheet references appear in reports but never become collected fees or commission income',()=>{
 const result=reporting.summarize([{
  _id:{network:'MTN',currency:'UGX',operation:'cash_out',entrySource:'manual',
   feeTreatment:'record_only',status:'recorded',reviewState:'not_required',voided:false},
  count:1,amountMinor:'50000',feeMinor:'0',cashMovementMinor:'-50000',
  estimatedCommissionMinor:'0',customerNetworkChargeEstimateMinor:'0',
  publishedCommissionReferenceMinor:'325',publishedCustomerChargeReferenceMinor:'1500'
 }],[],[]);
 const row=result.networks[0];
 assert.equal(row.publishedCommissionReferenceMinor,325n);
 assert.equal(row.publishedCustomerChargeReferenceMinor,1500n);
 assert.equal(row.recordedFeeMinor,0n);
 assert.equal(row.collectedFeeMinor,0n);
 assert.equal(row.receivedCommissionMinor,0n);
 const csv=reporting.csv({networks:result.networks,window:{timeZone:'Africa/Kampala',from:'2026-11-16',to:'2026-11-16'},expenses:[]});
 assert.match(csv,/Published agent commission reference/);
 assert.match(csv,/Published customer network charge/);
 assert.match(csv,/"325","1500"/);
});
