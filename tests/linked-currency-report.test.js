'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const report=require('../src/tenant/services/mobileMoneyUnifiedReport.service');
const group=(network,currency,cashCurrency,operation,amountMinor,cashMovementMinor)=>({
 _id:{network,currency,cashCurrency,operation,entrySource:'manual',
  feeTreatment:'record_only',voided:false,reviewState:'not_required',status:'recorded'},
 count:1,amountMinor,feeMinor:'0',cashMovementMinor
});
test('SSP drawer payment is not misreported as UGX cash or commission income',()=>{
 const outcome=report.summarize([
  group('MTN','UGX','SSP','cash_out','100000','-9000000'),
  group('MTN','UGX','SSP','cash_in','200000','22000000')
 ],[],[]);
 const provider=outcome.currencies.find(row=>row.currency==='UGX');
 assert(provider);
 assert.equal(provider.volumeMinor,300000n);
 assert.equal(provider.cashImpactMinor,0n);
 assert.equal(provider.withdrawalCount,1);
 assert.equal(provider.depositCount,1);
 assert.equal(provider.receivedCommissionMinor,0n);
 const cash=outcome.cashMovements.find(row=>row.network==='MTN'&&row.currency==='SSP');
 assert(cash);
 assert.equal(cash.amountMinor,'13000000');
 assert.equal(cash.formatted,'SSP 130,000.00');
});
test('KES float turnover and SSP drawer custody remain two independent native currencies',()=>{
 const outcome=report.summarize([group('M-Pesa','KES','SSP','cash_out','100000','-1350000')],[],[]);
 assert.equal(outcome.currencies[0].currency,'KES');
 assert.equal(outcome.currencies[0].volumeMinor,100000n);
 assert.equal(outcome.currencies[0].cashImpactMinor,0n);
 assert.equal(outcome.cashMovements[0].currency,'SSP');
 assert.equal(outcome.cashMovements[0].amountMinor,'-1350000');
 const csv=report.csv({window:{timeZone:'Africa/Juba',from:'2026-11-01',to:'2026-11-17'},
  networks:outcome.networks,cashMovements:outcome.cashMovements,expenses:[]});
 assert.match(csv,/Physical cash currency/);
 assert.match(csv,/SSP\",\"M-Pesa\",\"'-1350000/);
});
test('ordinary same-currency mobile money keeps the existing cash movement reporting contract',()=>{
 const outcome=report.summarize([group('MTN SSD','SSP','SSP','cash_in','30000','30000')],[],[]);
 assert.equal(outcome.currencies[0].cashImpactMinor,30000n);
 assert.equal(outcome.cashMovements[0].amountMinor,'30000');
});
