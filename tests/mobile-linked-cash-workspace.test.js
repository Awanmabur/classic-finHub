'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const path=require('node:path');
const workspace=require('../src/tenant/services/mobileMoneyWorkspace.service');
const group=({currency,cashCurrency,operation='cash_out',amountMinor,cashMovementMinor,
 network='M-Pesa',paymentMethod='Cash',voided=false})=>({
 _id:{currency,cashCurrency,network,operation,source:'manual',paymentMethod,voided},
 count:1,amountMinor,feeMinor:'0',cashMovementMinor
});
test('KES M-Pesa withdrawal paying SSP cash never labels drawer movement as KES',()=>{
 const result=workspace.summarize([
  group({currency:'KES',cashCurrency:'SSP',amountMinor:'10000',cashMovementMinor:'-1100000'}),
  group({currency:'UGX',cashCurrency:'SSP',network:'MTN',amountMinor:'4000',cashMovementMinor:'-400000'}),
  group({currency:'KES',cashCurrency:'KES',amountMinor:'1000',cashMovementMinor:'-1000'}),
  group({currency:'KES',cashCurrency:'SSP',amountMinor:'10000',cashMovementMinor:'-1100000',voided:true}),
  group({currency:'KES',cashCurrency:'SSP',amountMinor:'3500',cashMovementMinor:'0',paymentMethod:'Bank'})
 ]);
 const kes=result.summary.byCurrency.find(x=>x.currency==='KES');
 assert.equal(kes.volumeMinor,'14500');
 assert.equal(kes.cashImpactMinor,'-1000');
 assert.equal(kes.physicalCashOutMinor,'1000');
 const ssp=result.summary.cashByCurrency.find(x=>x.currency==='SSP');
 assert.equal(ssp.cashImpactMinor,'-1500000');
 assert.equal(ssp.formatted.cashImpact,'SSP -15,000.00');
 assert.equal(ssp.physicalCashOutCount,2);
 assert.equal(ssp.formatted.physicalCashOut,'SSP 15,000.00');
 assert.equal(result.summary.cashByCurrency.find(x=>x.currency==='KES').cashImpactMinor,'-1000');
 assert.equal(result.summary.voidedCount,1);
});
test('cross-currency deposits are counted in actual drawer currency with exact signed cash delta',()=>{
 const result=workspace.summarize([
  group({currency:'KES',cashCurrency:'SSP',operation:'cash_in',amountMinor:'2500',cashMovementMinor:'300000',network:'M-Pesa'}),
  group({currency:'KES',cashCurrency:'SSP',operation:'cash_out',amountMinor:'1000',cashMovementMinor:'-120000',network:'M-Pesa'})
 ]);
 const ssp=result.summary.cashByCurrency[0];
 assert.equal(ssp.currency,'SSP');
 assert.equal(ssp.cashImpactMinor,'180000');
 assert.equal(ssp.physicalCashInMinor,'300000');
 assert.equal(ssp.physicalCashOutMinor,'120000');
 assert.equal(result.summary.byCurrency[0].cashImpactMinor,'0');
});
test('Mobile Money CSV exports the physical cash amount with its original SSP denomination',()=>{
 const record={createdAt:new Date('2026-11-17T11:00:00Z'),
  operation:'cash_out',customer:'Private customer',customerPhone:'',network:'M-Pesa',
  networkReference:'MPESA-CROSS-01',currency:'KES',cashCurrency:'SSP',
  amountMinor:'10000',feeMinor:'0',paymentMethod:'Cash',entrySource:'manual',
  status:'recorded',reviewState:'not_required',correctionState:'none',
  physicalCashMovementMinor:'-1100000'};
 const csv=workspace.toCsv([record],'Africa/Juba');
 assert.match(csv,/Provisional cash impact \(native cash currency\)/);
 assert.match(csv,/Actual cash currency/);
 assert.match(csv,/,"-11000\.00","SSP"\r\n$/);
 assert.doesNotMatch(csv,/,"-11000\.00","KES"\r\n$/);
});
test('the actual cash page renders SSP in the existing cards without counting unverified provider fees as cash',async()=>{
 const result=workspace.summarize([group({currency:'KES',cashCurrency:'SSP',amountMinor:'10000',cashMovementMinor:'-1100000'})]);
 const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/tenant/mobile-money/cash-impact.ejs'),{
  user:{role:'Mobile Money Operator',permissions:['mobile_money.view']},
  data:{summary:result.summary,canRecord:false,records:{items:[],nextCursor:null},
   canReport:true,filters:{from:'2026-11-17',to:'2026-11-17'}}
 });
 assert.match(html,/SSP 11,000\.00/);
 assert.match(html,/Actual physical cash movements only/);
 assert.doesNotMatch(html,/Fee \/ commission recorded/);
 assert.doesNotMatch(html,/KES -11,000\.00/);
});
