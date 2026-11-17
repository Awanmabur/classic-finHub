'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {stateFor,authorized,LIMIT}=require('../src/tenant/settlements/transferReconciliation');
const {tenantDbNameFromSlug}=require('../src/config/tenantDatabaseName');
const {entitledTenant}=require('./helpers/entitlement');
const ID={
 tenant:'507f1f77bcf86cd799439010',origin:'507f1f77bcf86cd799439011',
 destination:'507f1f77bcf86cd799439012',source:'507f1f77bcf86cd799439013',
 collection:'507f1f77bcf86cd799439014',payout:'507f1f77bcf86cd799439015'};
const slug='linked-reconciliation-test';
const tenant={...entitledTenant({plan:'enterprise',enabledModules:['money_transfer','forex']}),_id:ID.tenant,slug,
 dbName:tenantDbNameFromSlug(slug)};
const owner={id:ID.tenant,role:'Tenant Owner',permissions:['*'],allowedModules:['money_transfer','forex']};
const row={
 sourceId:ID.source,sourceReference:'REAL-REF-01',branchId:ID.origin,
 destinationBranchId:ID.destination,
 cashCurrency:'SSP',providerCurrency:'USD',physicalCashMinor:'65000',
 providerPrincipalMinor:'500',cashAccountId:ID.collection,destinationPayoutAccountId:ID.payout,
 postingBatchIds:[ID.source,ID.collection,ID.payout],status:'posted',
 postedAt:new Date('2026-11-17'),occurredAt:new Date('2026-11-17'),
 providerState:'unverified'
};
const order={_id:ID.source,amountMinor:'65000',currency:'SSP',
 payoutMinor:'500',payoutCurrency:'USD',
 status:'paid_out_manual',branchId:ID.origin,destinationBranchId:ID.destination};
test('a paid interbranch transfer preserves both currencies, and does not pretend dues are settled',()=>{
 const result=stateFor(row,order,false,['cash_collected','cash_paid']);
 assert.equal(result.collection,'SSP 650.00');
 assert.equal(result.payout,'USD 5.00');
 assert.match(result.branchState,/remain until independently reconciled/);
 assert.match(result.stage,/internal books/);
 assert.equal(result.needsReview,false);
 assert.equal(result.verifiedProvider,false);
});
test('a collected but unpaid transfer is not shown as a completed payout',()=>{
 const pending=stateFor({...row,status:'collected',destinationPayoutAccountId:null,
  postingBatchIds:[ID.source],postedAt:null},{...order,status:'collected_manual'},true,['cash_collected']);
 assert.match(pending.stage,/awaiting independent review/);
 assert.match(pending.branchState,/No recipient cash payout/);
 assert.equal(pending.needsReview,false);
});
test('settlement diagnostics flag a broken recipient account link, missing cash-paid event or changed economics',()=>{
 const bad=stateFor({...row,destinationPayoutAccountId:null},order,false,['cash_collected']);
 assert.equal(bad.needsReview,true);
 assert.match(bad.issues.join('|'),/recipient payout evidence/);
 const changed=stateFor(row,{...order,amountMinor:'65001'},false,['cash_collected','cash_paid']);
 assert.equal(changed.needsReview,true);
 assert.match(changed.issues.join('|'),/disagree/);
});
test('same-branch cross-currency payout is not mislabeled interbranch settlement',()=>{
 const result=stateFor({...row,destinationBranchId:ID.origin},
  {...order,destinationBranchId:ID.origin},false,['cash_collected','cash_paid']);
 assert.match(result.branchState,/Same-branch currency/);
});
test('scoped reconciliation rejects cross-tenant data, weak roles and unassigned branch supervisors',()=>{
 const conn={name:tenantDbNameFromSlug(tenant.slug)};
 const ownTenant={...tenant,dbName:conn.name};
 assert.doesNotThrow(()=>authorized(conn,ownTenant,owner,{}));
 assert.throws(()=>authorized({...conn,name:'other_tenant'},ownTenant,owner,{}),{status:403});
 assert.throws(()=>authorized(conn,ownTenant,{...owner,role:'Viewer'},{}),{status:403});
 assert.throws(()=>authorized(conn,ownTenant,{...owner,role:'Branch Manager'},{}),{status:403});
 assert.throws(()=>authorized(conn,ownTenant,{...owner,role:'Branch Manager'},
  {branchId:'not-an-id'}),{status:403});
 assert.equal(LIMIT,50);
});
