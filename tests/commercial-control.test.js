'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {plans}=require('../src/data/store');
const {entitledTenant}=require('./helpers/entitlement');
const commerce=require('../src/platform/services/commercial.service');
const {hasModule,assignableModules}=require('../src/tenant/services/moduleAccess.service');
const tenant=entitledTenant({_id:'507f1f77bcf86cd799439011',plan:'agent',enabledModules:['mobile_money'],seatsReserved:3,branchCount:1});
test('published snapshots use exact minor units, immutable versions and bounded plan terms',()=>{
  const agent=commerce.asPlanVersion(plans.find(p=>p.code==='agent'));
  assert.equal(agent.priceMonthlyMinor,14900);
  assert.equal(agent.priceYearlyMinor,149000);
  const snap=commerce.planSnapshot({...agent,status:'published'});
  assert.equal(snap.planCode,'agent');assert.equal(snap.limits.users,12);
  assert.equal(snap.modules.includes('mobile_money'),true);
  assert.throws(()=>commerce.planSnapshot({...agent,status:'draft'}),e=>e.status===409);
  assert.throws(()=>commerce.planSnapshot({...agent,status:'published',modules:['evil_module']}),e=>e.status===409);
  assert.equal(commerce.checksum(agent).length,64);
});
test('new paid entitlement is unusable when absent, expired, revoked, suspended, or mismatched',()=>{
  assert(commerce.effectiveSubscription(tenant));
  for(const changed of [
    {...tenant,subscription:undefined},
    {...tenant,status:'suspended'},
    {...tenant,plan:'finance'},
    {...tenant,subscription:{...tenant.subscription,status:'revoked'}},
    {...tenant,subscription:{...tenant.subscription,periodEnd:new Date('2020-01-01')}},
    {...tenant,subscription:{...tenant.subscription,generation:0}},
  ]){assert.equal(commerce.effectiveSubscription(changed),null);assert.equal(hasModule(changed,'mobile_money'),false);}
  assert.equal(hasModule(tenant,'mobile_money'),true);
  assert(!hasModule(tenant,'banking'));
  assert.deepEqual(assignableModules(tenant,'Mobile Money Operator'),['mobile_money']);
});
test('manual grant inputs and capacity constraints reject unsafe operations',()=>{
  const okay=commerce.grantInput({planCode:'agent',days:'30',reason:'This is a legitimate support grant for a verified account.'});
  assert.equal(okay.days,30);
  for(const bad of [
    {planCode:'agent',days:0,reason:'Valid administrative request justification'},
    {planCode:'agent',days:367,reason:'Valid administrative request justification'},
    {planCode:'agent',days:'3.5',reason:'Valid administrative request justification'},
    {planCode:'__invalid',days:30,reason:'Valid administrative request justification'},
    {planCode:'agent',days:30,reason:'short'},
  ])assert.throws(()=>commerce.grantInput(bad));
  assert.doesNotThrow(()=>commerce.validateCapacity(tenant,{limits:{users:3,branches:1}}));
  assert.throws(()=>commerce.validateCapacity(tenant,{limits:{users:2,branches:1}}),e=>e.status===409);
  assert.throws(()=>commerce.validateCapacity(tenant,{limits:{users:3,branches:0}}),e=>e.status===409);
});
test('usage reservation uses atomic conditional counter and UTC period, quota failure is closed',async()=>{
  let last;
  const Model={findOneAndUpdate:async(filter,update,options)=>{last={filter,update,options};return {quantity:1};}};
  const session={id:'unit'};
  await commerce.reserveUsage(tenant,'mobile_money_records',session,new Date('2026-11-30T23:59:59Z'),Model);
  assert.equal(last.filter.period,'2026-11');
  assert.equal(last.filter.quantity.$lt,5000);
  assert.equal(last.update.$inc.quantity,1);
  assert.equal(last.options.session,session);
  assert.equal(last.options.upsert,true);
  await assert.rejects(commerce.reserveUsage({...tenant,subscription:{...tenant.subscription,limits:{...tenant.subscription.limits,transactionsPerMonth:0}}},'mobile_money_records',session,new Date(),Model),e=>e.status===429);
  await assert.rejects(commerce.reserveUsage({...tenant,status:'suspended'},'mobile_money_records',session,new Date(),Model),e=>e.status===403);
  await assert.rejects(commerce.reserveUsage(tenant,'unknown',session,new Date(),Model),e=>e.status===403);
  await assert.rejects(commerce.reserveUsage(tenant,'mobile_money_records',session,new Date(),{findOneAndUpdate:async()=>{const e=new Error('duplicate');e.code=11000;throw e;}}),e=>e.status===429);
});
test('published plan version unique index and usage index are scoped by tenant and generation',()=>{
 const indexes=require('../src/platform/models/PlanVersion').schema.indexes();
 assert(indexes.some(([key,opts])=>key.code===1&&key.version===1&&opts.unique));
 const usage=require('../src/platform/models/UsageCounter').schema.indexes();
 assert(usage.some(([key,opts])=>key.tenantId===1&&key.generation===1&&key.metric===1&&opts.unique));
});
test('manual renewals extend the existing term without resetting a monthly quota',()=>{
  const earlier={...tenant.subscription,status:'granted',periodStart:new Date('2026-10-01'),periodEnd:new Date('2026-12-01'),generation:5};
  const renewal=commerce.computeGrantPeriod(earlier,earlier,15,new Date('2026-11-03'));
  assert.equal(renewal.extension,true);assert.equal(renewal.generation,5);
  assert.equal(renewal.end.toISOString().slice(0,10),'2026-12-16');
  const change=commerce.computeGrantPeriod(earlier,{...earlier,planVersion:2},15,new Date('2026-11-03'));
  assert.equal(change.extension,false);assert.equal(change.generation,6);
  assert.equal(change.end.toISOString().slice(0,10),'2026-11-18');
  assert.throws(()=>commerce.computeGrantPeriod(earlier,earlier,366,new Date('2026-11-03')),e=>e.status===409);
});
test('new plan version publication rejects arbitrary fields, unknown modules and unsafe prices',()=>{
 const source=commerce.asPlanVersion(plans.find(p=>p.code==='agent'));
 const {version,...next}=source;
 assert.deepEqual(commerce.validateNewVersion(next),next);
 assert.throws(()=>commerce.validateNewVersion({...next,moduleInject:'evil'}));
 assert.throws(()=>commerce.validateNewVersion({...next,modules:['not_a_real_module']}));
 assert.throws(()=>commerce.validateNewVersion({...next,priceMonthlyMinor:-1}));
 assert.throws(()=>commerce.validateNewVersion({...next,priceMonthlyMinor:'1000'}));
 assert.throws(()=>commerce.validateNewVersion({...next,limits:{...next.limits,users:0}}));
 assert.throws(()=>commerce.validateNewVersion({...next,code:'surprise_plan'}));
});
test('subscription schema supports embedded versioned snapshots and safe revocation',()=>{
 const Tenant=require('../src/platform/models/Tenant');
 const record=new Tenant({name:'Tenant',slug:'test-tenant',dbName:'classicfin_tenant_test_tenant_db',email:'owner@example.invalid',
  plan:'agent',status:'active',subscription:tenant.subscription});
 const validation=record.validateSync();
 assert.equal(validation,undefined,validation?.message);
 record.subscription.status='revoked';
 assert.equal(commerce.effectiveSubscription(record),null);
});
