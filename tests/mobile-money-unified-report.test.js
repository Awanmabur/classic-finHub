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
  {_id:{fundingState:'book_recorded',network:'MTN',currency:'UGX',operation:'cash_in',entrySource:'manual',feeTreatment:'record_only',status:'pending_verification',reviewState:'awaiting_review',voided:false},
   count:1,amountMinor:'250000',feeMinor:'200',cashMovementMinor:'250000',estimatedCommissionMinor:'500'},
  {_id:{fundingState:'book_recorded',network:'MTN',currency:'UGX',operation:'cash_out',entrySource:'sms',feeTreatment:'payment_collected',status:'pending_verification',reviewState:'accepted',voided:false},
   count:1,amountMinor:'100000',feeMinor:'1000',cashMovementMinor:'-99000',estimatedCommissionMinor:'600'},
  {_id:{fundingState:'book_recorded',network:'Airtel',currency:'UGX',operation:'cash_in',entrySource:'manual',feeTreatment:'record_only',status:'voided_internal',reviewState:'awaiting_review',voided:true},
   count:1,amountMinor:'900000',feeMinor:'80000',cashMovementMinor:'900000',estimatedCommissionMinor:'1000'},
  {_id:{fundingState:'book_recorded',network:'MTN SSD',currency:'SSP',operation:'cash_in',entrySource:'sms',feeTreatment:'record_only',status:'pending_verification',reviewState:'accepted',voided:false},
   count:1,amountMinor:'1000',feeMinor:'0',cashMovementMinor:'1000',estimatedCommissionMinor:'0'}
 ];
 const payouts=[{_id:{fundingState:'book_recorded',network:'MTN',currency:'UGX'},amountMinor:'700',grossMinor:'700',taxMinor:'0',costMinor:'0'}];
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
  _id:{fundingState:'book_recorded',network:'MTN',currency:'UGX',operation:'cash_in',entrySource:'manual',feeTreatment:'wallet_commission',status:'pending_verification',reviewState:'accepted',voided:false},
  count:1,amountMinor:'10000',feeMinor:'400',cashMovementMinor:'10000',estimatedCommissionMinor:'400'
 }],[],[]);
 assert.equal(result.currencies[0].legacyWalletFeeMinor,400n);
 assert.equal(result.currencies[0].receivedCommissionMinor,0n);
});

test('published provider fee-sheet references appear in reports but never become collected fees or commission income',()=>{
 const result=reporting.summarize([{
  _id:{fundingState:'book_recorded',network:'MTN',currency:'UGX',operation:'cash_out',entrySource:'manual',
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

test('cross-currency records appear in existing Mobile Money CSV without combining native currencies',()=>{
 const csv=reporting.csv({networks:[],expenses:[],fxRows:[{network:'MTN',
  operation:'withdraw_provider_receive_cash',providerCurrency:'UGX',cashCurrency:'SSP',
  count:1,providerMinor:'1000',cashMinor:'90000',unverified:1}],
  window:{timeZone:'Africa/Juba',from:'2026-11-18',to:'2026-11-18'}});
 assert.match(csv,/Cross-currency Mobile Money/);
 assert.match(csv,/"MTN","withdraw_provider_receive_cash","UGX","SSP","1","1000","90000","1"/);
 assert.doesNotMatch(csv,/91000/,'unlike currencies must not be summed');
});

test('linked UGX to SSP withdrawals and deposits keep wallet principal and SSP cash in separate currencies',()=>{
 const groups=[
  {_id:{fundingState:'book_recorded',network:'MTN',currency:'UGX',cashCurrency:'SSP',paymentMethod:'Cash',
   operation:'cash_out',entrySource:'manual',feeTreatment:'record_only',
   status:'recorded',reviewState:'not_required',voided:false},
   count:1,amountMinor:'1000',cashMovementMinor:'-90000',feeMinor:'0',estimatedCommissionMinor:'10'},
  {_id:{fundingState:'book_recorded',network:'MTN',currency:'UGX',cashCurrency:'SSP',paymentMethod:'Cash',
   operation:'cash_in',entrySource:'manual',feeTreatment:'record_only',
   status:'recorded',reviewState:'not_required',voided:false},
   count:1,amountMinor:'500',cashMovementMinor:'50000',feeMinor:'0',estimatedCommissionMinor:'8'}
 ];
 const result=reporting.summarize(groups,[],[]);
 assert.equal(result.currencies.length,1,'electronic principal is UGX');
 assert.equal(result.currencies[0].volumeMinor,1500n);
 assert.equal(result.currencies[0].floatMovementMinor,500n);
 assert.equal(result.currencies[0].cashImpactMinor,0n,'SSP must never be recorded as UGX cash');
 assert.equal(result.currencies[0].estimatedCommissionMinor,18n,'approved sheet estimates included');
 assert.equal(result.cashCurrencies.length,1);
 assert.equal(result.cashCurrencies[0].currency,'SSP');
 assert.equal(result.cashCurrencies[0].inMinor,50000n);
 assert.equal(result.cashCurrencies[0].outMinor,90000n);
 assert.equal(result.cashCurrencies[0].movementMinor,-40000n);
});

test('historical untracked Mobile Money entries never invent physical cash or float movements',()=>{
 const result=reporting.summarize([{
  _id:{network:'MTN',currency:'UGX',cashCurrency:'UGX',
   fundingState:'legacy_untracked',paymentMethod:'Cash',operation:'cash_in',
   entrySource:'manual',feeTreatment:'record_only',status:'recorded',
   reviewState:'not_required',voided:false},
  count:1,amountMinor:'100000',feeMinor:'0',cashMovementMinor:'100000',
  estimatedCommissionMinor:'20'
 }],[],[]);
 assert.equal(result.currencies[0].volumeMinor,100000n,'historical recorded volume remains visible');
 assert.equal(result.currencies[0].floatMovementMinor,0n,'historical volume must not invent float');
 assert.equal(result.cashCurrencies.length,0,'no real posted cash recorded');
 assert.equal(result.currencies[0].cashImpactMinor,0n);
});


test('CSV contains SSP physical cash and UGX float movements on different rows, with observation-date evidence',()=>{
 const report=reporting.summarize([{
  _id:{network:'MTN',currency:'UGX',cashCurrency:'SSP',paymentMethod:'Cash',fundingState:'book_recorded',
   operation:'cash_out',entrySource:'manual',feeTreatment:'record_only',status:'recorded',reviewState:'not_required',voided:false},
  count:1,amountMinor:'1000',cashMovementMinor:'-90000',feeMinor:'0',
  estimatedCommissionMinor:'10'
 }],[],[]);
 report.window={timeZone:'Africa/Juba',from:'2026-11-19',to:'2026-11-19'};
 report.positionsAccessible=true;
 report.positions=[{name:'SSP Cash',kind:'cash',network:'',currency:'SSP',bookFormatted:'SSP 400.00',
  actualFormatted:'SSP 500.00',comparedBookFormatted:'SSP 500.00',varianceFormatted:'SSP 0.00',
  status:'matched at last count',observedAt:new Date('2026-11-19T05:00:00Z')}];
 const csv=reporting.csv(report);
 assert.match(csv,/Net provider float movement/);
 assert.match(csv,/Actual physical cash flows by drawer currency/);
 assert.match(csv,/"SSP","1","0","90000","-90000"/);
 assert.match(csv,/"MTN","UGX","0","1"/);
 assert.match(csv,/Current book balances and last independently observed balances/);
 assert.match(csv,/2026-11-19T05:00:00.000Z/);
 assert.doesNotMatch(csv,/91000/,'UGX and SSP principal cannot be summed');
 report.positionsAccessible=false;
 assert.doesNotMatch(reporting.csv(report),/SSP Cash/,'unprivileged CSV must not reveal account-level balances');
});
test('corrected original cross-currency records stay in audit volume but do not inflate active cash or float',()=>{
 const groups=[{
  _id:{fundingState:'book_recorded',network:'MTN',currency:'UGX',
   cashCurrency:'SSP',paymentMethod:'Cash',operation:'cash_out',
   entrySource:'manual',feeTreatment:'record_only',status:'voided_internal',
   reviewState:'not_required',voided:true},
  count:1,amountMinor:'1000',cashMovementMinor:'-90000',feeMinor:'0',
  estimatedCommissionMinor:'0'
 }];
 const result=reporting.summarize(groups,[],[]);
 assert.equal(result.currencies[0].voidedCount,1);
 assert.equal(result.currencies[0].volumeMinor,0n);
 assert.equal(result.currencies[0].floatMovementMinor,0n);
 assert.equal(result.cashCurrencies.length,0);
});
