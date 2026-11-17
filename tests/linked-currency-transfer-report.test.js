'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const service=require('../src/tenant/services/operationWorkspace.service');
const {entitledTenant}=require('./helpers/entitlement');
const tenant=entitledTenant({plan:'enterprise',enabledModules:['money_transfer','forex']});
const owner={id:'507f1f77bcf86cd799439012',role:'Tenant Owner',permissions:['*'],allowedModules:['money_transfer','forex']};
test('Money Transfer report groups by both sender and recipient native currency instead of merging USD and KES payouts',async()=>{
 let pipeline;
 const conn={models:{TransferOrderV1:{aggregate:async input=>{
  pipeline=input;
  return [
   {_id:{day:'2026-11-16',currency:'SSP',targetCurrency:'USD',
     status:'paid_out_manual',kind:'transfer_request'},count:2,volume:'2600000',target:'20000',fees:'0'},
   {_id:{day:'2026-11-16',currency:'SSP',targetCurrency:'KES',
     status:'collected_manual',kind:'transfer_request'},count:1,volume:'600000',target:'50000',fees:'0'}
  ];
 }}}};
 const report=await service.report(conn,tenant,owner,'money_transfer',{
  from:'2026-11-16',to:'2026-11-16'},'Africa/Juba');
 assert.equal(pipeline[1].$group._id.targetCurrency.$ifNull[0],'$payoutCurrency');
 assert.equal(pipeline[1].$group.target.$sum.$ifNull[0],'$payoutMinor');
 assert.equal(report.rows.length,2);
 assert.equal(report.rows[0].currency,'SSP');
 assert.equal(report.rows[0].targetCurrency,'USD');
 assert.equal(report.rows[0].volume,'SSP 26,000.00');
 assert.equal(report.rows[0].target,'USD 200.00');
 assert.equal(report.rows[1].targetCurrency,'KES');
 assert.equal(report.rows[1].target,'KES 500.00');
 assert.equal(report.total,3);
 const exported=service.csv(report);
 assert.match(exported,/USD 200.00/);
 assert.match(exported,/KES 500.00/);
 assert.match(exported,/SSP 26,000.00/);
});
test('A historical same-currency transfer still reports payout in its original currency',()=>{
 const old={_id:'507f1f77bcf86cd799439013',currency:'SSP',amountMinor:'65000',
  feeMinor:'0',sender:{name:'Sender'},beneficiary:{name:'Beneficiary'},reference:'TR-LEGACY'};
 const output=service.describe('money_transfer',old);
 assert.equal(output.volume,'SSP 650.00');
 assert.equal(output.target,'SSP 650.00');
});
