'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {schema}=require('../src/tenant/settlements/interbranchCash.models');
const settlement=require('../src/tenant/settlements/interbranchCash.service');
const oids={a:'507f1f77bcf86cd799439010',b:'507f1f77bcf86cd799439011',
 src:'507f1f77bcf86cd799439012',col:'507f1f77bcf86cd799439013',
 payout:'507f1f77bcf86cd799439014',sacct:'507f1f77bcf86cd799439015',
 dacct:'507f1f77bcf86cd799439016',maker:'507f1f77bcf86cd799439017',
 receiver:'507f1f77bcf86cd799439018'};
const source={_id:oids.src,status:'paid_out_manual',
 branchId:oids.a,destinationBranchId:oids.b,currency:'UGX',
 amountMinor:'10000',manualCollectionExecutionId:oids.col,
 manualPayoutExecutionId:oids.payout};
const collection={_id:oids.col,sourceId:oids.src,sourceType:'money_transfer',
 status:'posted_manual',action:'transfer_collect',branchId:oids.a,
 createdBy:oids.maker,accounts:{collectionAccountId:oids.sacct}};
const payout={_id:oids.payout,sourceId:oids.src,sourceType:'money_transfer',
 status:'posted_manual',action:'transfer_payout',branchId:oids.b,
 createdBy:oids.receiver,collectionExecutionId:oids.col,
 accounts:{payoutAccountId:oids.dacct}};
const pair=settlement.sourcePair(source,collection,payout);
const accounts=[
 {_id:oids.sacct,kind:'cash',branchId:oids.a,currency:'UGX',operatorId:oids.maker,
  status:'active',reconciliationState:'matched',openingBalanceMinor:'10000',
  openingApprovedAt:new Date(),bookBalanceMinor:'10000'},
 {_id:oids.dacct,kind:'cash',branchId:oids.b,currency:'UGX',operatorId:oids.receiver,
  status:'active',reconciliationState:'matched',openingBalanceMinor:'1000',
  openingApprovedAt:new Date(),bookBalanceMinor:'1000'}
];
test('reimbursement can only use the exact independently posted original and receiving cashier drawers',()=>{
 assert.equal(pair.currency,'UGX');
 assert.equal(pair.amountMinor,'10000');
 assert.equal(pair.sourceCashAccountId,oids.sacct);
 assert.equal(pair.destinationCashAccountId,oids.dacct);
 assert.equal(settlement.readyAccounts(pair,accounts).source.bookBalanceMinor,'10000');
});
test('cross-currency SSP-to-USD is blocked, not netted through a fabricated conversion',()=>{
 assert.throws(()=>settlement.sourcePair({...source,currency:'SSP',payoutCurrency:'USD'},collection,payout),{status:409});
 assert.throws(()=>settlement.sourcePair({...source,status:'collected_manual'},collection,payout),{status:409});
 assert.throws(()=>settlement.sourcePair({...source,destinationBranchId:oids.a},collection,payout),{status:409});
 assert.throws(()=>settlement.sourcePair(source,collection,{...payout,status:'pending_review'}),{status:409});
 assert.throws(()=>settlement.sourcePair(source,{...collection,branchId:oids.b},payout),{status:409});
 assert.throws(()=>settlement.sourcePair(source,collection,{...payout,collectionExecutionId:oids.payout}),{status:409});
});
test('wrong branch, cashier, inactive, stale and insufficient cash are blocked before reimbursement',()=>{
 for(const change of [{currency:'USD'},{branchId:oids.b},{operatorId:oids.receiver},
  {kind:'wallet'},{reconciliationState:'mismatch'},{status:'held'},
  {bookBalanceMinor:'9999'},{openingApprovedAt:null}]){
  assert.throws(()=>settlement.readyAccounts(pair,[{...accounts[0],...change},accounts[1]]),{status:409});
 }
 assert.throws(()=>settlement.readyAccounts(pair,[accounts[0],
  {...accounts[1],currency:'SSP'}]),{status:409});
});
test('reimbursement request uses a real sender evidence reference and idempotency UUID',()=>{
 const good={idempotencyKey:crypto.randomUUID(),evidenceReference:'SENDER-HANDOVER-001',
  note:'Verified original collected cash sent to branch B'};
 assert.equal(settlement.requestInput(good).evidenceReference,good.evidenceReference);
 assert.throws(()=>settlement.requestInput({...good,idempotencyKey:'not-a-uuid'}),{status:400});
 assert.throws(()=>settlement.requestInput({...good,evidenceReference:'<svg/>'}),{status:400});
 assert.throws(()=>settlement.requestInput({...good,note:'short'}),{status:400});
});
test('physical sender and receiver signed receipt references are canonical and cannot evade anti-replay by letter case',()=>{
 assert.equal(settlement.receipt('sender-ugx-2026','sending receipt'),'SENDER-UGX-2026');
 assert.equal(settlement.receipt('RECEIVER-SSP:001','receiving receipt'),'RECEIVER-SSP:001');
 for(const value of ['=HYPERLINK(1,2)','<svg/onload=1>','seven','WRONG RECEIPT'])
  assert.throws(()=>settlement.receipt(value,'cash receipt'),{status:400});
 assert(schema.indexes().some(([fields,opt])=>fields.evidenceReference===1&&opt.unique));
 assert(schema.indexes().some(([fields,opt])=>fields.receiverReceiptReference===1&&opt.unique));
});
test('posting is disabled on deployments until real branch custody checks are approved',()=>{
 const old=process.env.CLASSICFIN_INTERBRANCH_CASH_SETTLEMENT;
 delete process.env.CLASSICFIN_INTERBRANCH_CASH_SETTLEMENT;
 try{assert.throws(()=>settlement.feature(),{status:403});}
 finally{if(old===undefined)delete process.env.CLASSICFIN_INTERBRANCH_CASH_SETTLEMENT;
  else process.env.CLASSICFIN_INTERBRANCH_CASH_SETTLEMENT=old;}
});
test('one active linked reimbursement and one retry key are enforced at the database index level',()=>{
 assert(schema.indexes().some(([fields,opt])=>fields.idempotencyKey===1&&opt.unique));
 assert(schema.indexes().some(([fields,opt])=>fields.activeKey===1&&opt.unique));
 assert(schema.path('status').enumValues.includes('rejected'));
 assert(schema.path('status').enumValues.includes('posted'));
});
