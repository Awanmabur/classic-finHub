#!/usr/bin/env node
'use strict';
// Deliberately destructive ONLY against random scratch tenant DBs on loopback.
// This script must never be pointed at a shared production database.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { mongoPlatformUri, nodeEnv } = require('../src/config/env');
const { connectPlatformMongo, getTenantConnection } = require('../src/config/mongo');
const { verifyReplicaPrimary } = require('../src/config/mongoTopology');
const { ensureTenantIndexes, mobileTransactionModel, auditEventModel,branchModel } = require('../src/tenant/models');
const mobile = require('../src/tenant/services/mobileMoney.service');
const cash=require('../src/tenant/services/cashDrawer.service');
const Tenant=require('../src/platform/models/Tenant');
const {asPlanVersion,planSnapshot}=require('../src/platform/services/commercial.service');
const {plans}=require('../src/data/store');

function localOnly() {
  if (nodeEnv === 'production') throw new Error('Never run scratch review tests in production');
  const uri = new URL(mongoPlatformUri);
  if (uri.protocol !== 'mongodb:' || !['localhost', '127.0.0.1','[::1]'].includes(uri.hostname) || uri.host.includes(',')) {
    throw new Error('Review integration is restricted to one loopback MongoDB replica set');
  }
}
async function main() {
  localOnly();
  await connectPlatformMongo();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({ hello: 1 }));
  const nonce=crypto.randomBytes(8).toString('hex');
  const slugs=[`probe-review-a-${nonce}`,`probe-review-b-${nonce}`];
  const [a,b]=slugs.map(getTenantConnection);
  const operator={id:String(new mongoose.Types.ObjectId()),role:'Mobile Money Operator',allowedModules:['mobile_money']};
  const reviewer={id:String(new mongoose.Types.ObjectId()),role:'Reconciliation Officer',allowedModules:['mobile_money']};
  let created;
  const snapshot=planSnapshot({...asPlanVersion(plans.find(p=>p.code==='agent')),status:'published'});
  const tenants=[];
  try {
    await Promise.all([ensureTenantIndexes(a),ensureTenantIndexes(b)]);
    for(const slug of slugs){
      const t=await Tenant.create({name:'Review integration scratch',slug,dbName:`classicfin_tenant_${slug.replace(/-/g,'_')}_db`,
        owner:'Test',email:`${slug}@example.invalid`,plan:'agent',status:'active',setupStatus:'complete',
        enabledModules:['mobile_money'],seatsReserved:1,branchCount:1,
        subscription:{...snapshot,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01')}});
      tenants.push(t);
    }
    const branch=await branchModel(a).create({name:'Scratch main',code:'scratch-main',currency:'UGX',createdBy:operator.id,updatedBy:operator.id});
    operator.branchId=String(branch._id);reviewer.branchId=String(branch._id);
    const shift=await cash.open(a,tenants[0],operator,{openingCash:'0'});
    assert.equal(shift.status,'pending_open');
    await assert.rejects(cash.decideOpening(a,tenants[0],{...operator,role:'Tenant Owner'},String(shift._id),
      {decision:'approve',note:'The originator cannot approve opening cash'}),e=>e.status===409);
    const verified=await cash.decideOpening(a,tenants[0],reviewer,String(shift._id),
      {decision:'approve',note:'Opening notes physically counted with second-person witness'});
    assert.equal(verified.status,'open');
    await assert.rejects(cash.open(a,tenants[0],operator,{openingCash:'0'}),e=>e.status===409,'duplicate active shift rejected');
    const input={idempotencyKey:crypto.randomUUID(),customer:'Integration Probe',network:'MTN',networkReference:`TEST-${nonce}`,
      currency:'UGX',amount:'120000',fee:'200'};
    const first=await mobile.recordMobileMoney(a,operator,input,'cash_in',tenants[0]);
    created=first.created;
    assert(!first.duplicate);
    assert.equal(first.created.status,'pending_verification');
    const repeated=await mobile.recordMobileMoney(a,operator,input,'cash_in',tenants[0]);
    assert(repeated.duplicate, 'identical retry must not double-post');
    assert.equal(String(first.created._id),String(repeated.created._id));
    await assert.rejects(mobile.reviewMobileMoney(a,{...reviewer,id:operator.id,role:'Tenant Owner'},String(created._id),'accepted','Receipt checked manually'),e=>e.status===409);
    await assert.rejects(mobile.reviewMobileMoney(b,reviewer,String(created._id),'accepted','Receipt checked manually'),e=>e.status===409,'other tenant cannot access record');
    const reviewed=await mobile.reviewMobileMoney(a,reviewer,String(created._id),'accepted','Receipt checked manually');
    assert.equal(reviewed.reviewState,'accepted');
    assert.equal(reviewed.status,'pending_verification', 'never count manual review as provider settlement');
    await assert.rejects(mobile.reviewMobileMoney(a,reviewer,String(created._id),'disputed','Changed mind about receipt'),e=>e.status===409);
    assert.equal(await mobileTransactionModel(a).countDocuments({idempotencyKey:input.idempotencyKey}),1);
    assert.equal(await mobileTransactionModel(b).countDocuments({}),0);
    assert.equal(await auditEventModel(a).countDocuments({targetId:created._id}),2,'record and review must both be audited');
    assert.equal(await auditEventModel(b).countDocuments({}),0);
    // A second record exercises the entire error-correction lifecycle, including
    // rejection, re-request, two-person approval, and cross-tenant access denial.
    const correctionInput={...input,idempotencyKey:crypto.randomUUID(),networkReference:`TEST-${nonce}-VOID`};
    const correction=(await mobile.recordMobileMoney(a,operator,correctionInput,'cash_out',tenants[0])).created;
    const correctionId=String(correction._id);
    await assert.rejects(mobile.requestVoid(b,operator,correctionId,'The recorded transaction is inaccurate'),e=>e.status===409);
    await mobile.requestVoid(a,operator,correctionId,'The originally entered cash-out value requires correction');
    assert.equal((await mobile.getReviewQueue(a,reviewer.id,25,String(branch._id))).some(x=>String(x._id)===correctionId),false,
      'an open correction request must not enter normal review');
    await assert.rejects(mobile.decideVoid(a,{...reviewer,id:operator.id,role:'Tenant Owner'},correctionId,'approve',
      'A second person must decide this case'),e=>e.status===409);
    await mobile.decideVoid(a,reviewer,correctionId,'deny','The first receipt does not establish an input error');
    await mobile.requestVoid(a,operator,correctionId,'Additional receipt confirms the input value is incorrect');
    const voided=await mobile.decideVoid(a,reviewer,correctionId,'approve','Second receipt confirms a recording error');
    assert.equal(voided.status,'voided_internal');
    assert.equal(voided.correctionHistory.length,4);
    assert.equal(await auditEventModel(a).countDocuments({targetId:correction._id}),5);
    assert.equal(await mobileTransactionModel(b).countDocuments({}),0);
    const history=await mobile.getTransactionPage(a,{branchId:String(branch._id)});
    assert(history.items.some(x=>String(x._id)===correctionId));
    await assert.rejects(mobile.getRecordDetails(b,correctionId,{}),e=>e.status===404);
    const summary=await mobile.getSummary(a);
    assert(summary.total>=1);
    assert.equal(summary.pending>=1,true);
    await assert.rejects(cash.submit(a,tenants[0],reviewer,String(shift._id),{countedCash:'120000'}),
      e=>e.status===403,'reviewers cannot submit another operator shift');
    await assert.rejects(cash.decide(a,tenants[0],{...operator,role:'Tenant Owner'},String(shift._id),
      {decision:'approve',note:'A different person must approve'}),e=>e.status===409,'open shift cannot be approved');
    const submitted=await cash.submit(a,tenants[0],operator,String(shift._id),{
      countedCash:'119000',note:'Counted notes and identified a one-thousand shilling difference'});
    assert.equal(submitted.status,'submitted');
    assert.equal(String(submitted.expectedClosingMinor),'120000');
    assert.equal(String(submitted.varianceMinor),'-1000');
    await assert.rejects(cash.decide(a,tenants[0],{...operator,role:'Tenant Owner'},String(shift._id),
      {decision:'approve',note:'Self approval must be denied'}),e=>e.status===409);
    await assert.rejects(cash.decide(b,tenants[1],reviewer,String(shift._id),
      {decision:'approve',note:'Cannot approve outside tenant'}),e=>e.status===409);
    const approved=await cash.decide(a,tenants[0],reviewer,String(shift._id),{
      decision:'approve',note:'Count discrepancy reviewed with supporting physical count'});
    assert.equal(approved.status,'approved');
    assert.equal(approved.activeKey,undefined);
    assert.equal((await cash.list(b,tenants[1],reviewer)).items.length,0);
    const check=await cash.reportRows({conn:a,filters:{},scope:{branchId:String(branch._id)}});
    assert(check.some(row=>row.status==='approved'&&row.count===1));
    await assert.rejects(cash.decide(a,tenants[0],reviewer,String(shift._id),{
      decision:'approve',note:'Second attempt must fail'}),e=>e.status===409);
    console.log('PASS: MongoDB shift opening, record binding, independent review, corrections, cash count, approval, reporting, idempotency and tenant isolation.');
  } finally {
    for (let i=0;i<slugs.length;i++) {
      const slug=slugs[i];
      if (!/^probe-review-[ab]-[a-f0-9]{16}$/.test(slug)) throw new Error('Unsafe scratch cleanup name');
      await [a,b][i].db.dropDatabase();
      if(tenants[i]){await Tenant.deleteOne({_id:tenants[i]._id,slug});
        await require('../src/platform/models/UsageCounter').deleteMany({tenantId:tenants[i]._id});}
    }
    await mongoose.disconnect();
  }
}
main().catch(error=>{console.error('Mobile Money review integration FAILED:',error.stack || error.message);process.exitCode=1;mongoose.disconnect().catch(()=>{});});
