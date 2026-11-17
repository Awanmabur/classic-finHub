'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const recovery=require('../src/tenant/settlements/transferRecovery');
const {tenantDbNameFromSlug}=require('../src/config/tenantDatabaseName');
const {entitledTenant}=require('./helpers/entitlement');
const id='507f1f77bcf86cd799439010';
const sample={
 _id:id,reference:'TR-UNPAID-123',status:'collected_manual',
 currency:'SSP',amountMinor:'65000',payoutCurrency:'USD',payoutMinor:'500',
 createdAt:new Date('2026-11-16T00:00:00Z'),
 manualPostedAt:new Date('2026-11-16T12:00:00Z')
};
const now=new Date('2026-11-17T16:00:00Z');
test('collected SSP remains owed as USD until receiver is actually paid, with a review reminder',()=>{
 const result=recovery.classify(sample,null,now);
 assert.equal(result.state,'awaiting_recipient');
 assert.equal(result.senderCollected,'SSP 650.00');
 assert.equal(result.recipientDue,'USD 5.00');
 assert.equal(result.hoursSinceCollection,28);
 assert.equal(result.needsAttention,true);
 assert.match(result.explanation,/no recipient payout request/);
 assert.doesNotMatch(result.explanation,/refunded|settled|reversed/);
});
test('pending reviewed payout is still unpaid but not a failed payout',()=>{
 const result=recovery.classify({...sample,manualPostedAt:new Date('2026-11-17T15:00:00Z')},
  {status:'pending_review'},now);
 assert.equal(result.state,'awaiting_payout_review');
 assert.equal(result.needsAttention,false);
 assert.match(result.explanation,/not been posted/);
});
test('rejected payout keeps collected money outstanding and requires a fresh PIN verification',()=>{
 const result=recovery.classify({...sample,manualPostedAt:new Date('2026-11-17T15:00:00Z')},
  {status:'rejected'},now);
 assert.equal(result.state,'payout_rejected');
 assert.equal(result.needsAttention,true);
 assert.match(result.explanation,/do not create a duplicate transfer/);
 assert.match(result.explanation,/No recipient cash was posted/);
});
test('a posted payout with a still-collected source is flagged as a stop-and-investigate inconsistency',()=>{
 const result=recovery.classify(sample,{status:'posted_manual'},now);
 assert.equal(result.state,'inconsistent_paid_status');
 assert.equal(result.needsAttention,true);
 assert.match(result.explanation,/STOP/);
 assert.match(result.explanation,/Do not pay again or refund/);
});
test('ordinary same-currency transfer preserves its native denomination and cannot be confused with FX',()=>{
 const result=recovery.classify({...sample,currency:'UGX',payoutCurrency:null,payoutMinor:null,amountMinor:'25000'},null,now);
 assert.equal(result.senderCollected,'UGX 25,000');
 assert.equal(result.recipientDue,'UGX 25,000');
});
test('refunded/cancelled/paid records cannot masquerade as collected unpaid cash',()=>{
 for(const state of ['paid_out_manual','cancelled','rejected','requested'])
  assert.throws(()=>recovery.classify({...sample,status:state},null,now),{status:409});
});
test('recovery queue is tenant- and branch-authorized, never available to tellers or outsiders',()=>{
 const slug='recovery-tenant-a';
 const tenant={...entitledTenant({plan:'enterprise',enabledModules:['money_transfer','forex']}),
  _id:id,slug,dbName:tenantDbNameFromSlug(slug)};
 const conn={name:tenant.dbName},actor={id,role:'Tenant Owner',permissions:['*'],allowedModules:['money_transfer','forex']};
 assert.doesNotThrow(()=>recovery.assertScope(conn,tenant,actor,{}));
 assert.throws(()=>recovery.assertScope({name:'other_db'},tenant,actor,{}),{status:403});
 assert.throws(()=>recovery.assertScope(conn,tenant,{...actor,role:'Money Transfer Operator'},{}),{status:403});
 assert.throws(()=>recovery.assertScope(conn,tenant,{...actor,role:'Branch Manager'},{}),{status:403});
 assert.doesNotThrow(()=>recovery.assertScope(conn,tenant,{...actor,role:'Branch Manager',branchId:id},
  {branchId:id}));
 assert.throws(()=>recovery.assertScope(conn,tenant,{...actor,role:'Branch Manager',branchId:id},
  {branchId:'507f1f77bcf86cd799439011'}),{status:403});
 assert.throws(()=>recovery.assertScope(conn,tenant,actor,{branchId:{$ne:null}}),{status:403});
 assert.equal(recovery.LIMIT,50);
});
