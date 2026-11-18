#!/usr/bin/env node
'use strict';
// Real financial services in disposable loopback replica-set databases ONLY.
// This synthetic test does not establish actual telecom/provider settlement.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||
 !['localhost','127.0.0.1','[::1]'].includes(configured.hostname)||
 configured.host.includes(',')||configured.username||configured.password)
 throw Error('Momo FX settlement integration must run against one isolated loopback replica set');
const nonce=crypto.randomBytes(7).toString('hex'),platformName='cfh_momofx_'+nonce,slug='momo-fx-'+nonce;
configured.pathname='/'+platformName;
process.env.MONGO_PLATFORM_URI=configured.toString();
process.env.NODE_ENV='test';
process.env.CLASSICFIN_MOMO_FX_POSTING_ENABLED='true';
process.env.CLASSICFIN_MOMO_FX_PROVIDER_EVIDENCE_HMAC_KEY_HEX='a'.repeat(64);
const mongoose=require('mongoose'),core=require('../src/tenant/models');
const Tenant=require('../src/platform/models/Tenant'),Usage=require('../src/platform/models/UsageCounter');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const commerce=require('../src/platform/services/commercial.service');
const treasury=require('../src/tenant/treasury/service'),tm=require('../src/tenant/treasury/models');
const mobileFxRates=require('../src/tenant/services/mobileMoneyFxRate.service');
const {preview}=require('../src/tenant/services/momoFxPreview.service');
const {settleVerified,settleManuallyConfirmed}=require('../src/tenant/services/momoFxSettlement.service');
const {records,grants}=require('../src/tenant/schemas/MomoFxSettlement');
const cash=require('../src/tenant/services/cashDrawer.service');
const {permissionsFor}=require('../src/config/roles');
function sign(proof){
 const keys=['providerStatus','providerReference','network','currency','amountMinor','evidenceId','verifiedAt','cashConfirmedAt','cashHandoverConfirmed'];
 const payload=JSON.stringify(Object.fromEntries(keys.map(key=>[key,proof[key]])));
 proof.evidenceSignature=crypto.createHmac('sha256',Buffer.from(process.env.CLASSICFIN_MOMO_FX_PROVIDER_EVIDENCE_HMAC_KEY_HEX,'hex')).update('momo-fx-provider-v1|'+payload).digest('hex');
 return proof;
}
let conn;
const id=()=>String(new mongoose.Types.ObjectId());
const owner={id:id(),name:'Currency Owner',role:'Tenant Owner',permissions:['*'],authVersion:0};
const reviewer={id:id(),name:'Independent Reviewer',role:'Reconciliation Officer',permissions:permissionsFor('Reconciliation Officer'),allowedModules:['mobile_money','forex','money_transfer','banking'],authVersion:0};
async function main(){
 await connectPlatformMongo();
 require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),Usage.createIndexes()]);
 conn=getTenantConnection(slug);
 await core.ensureTenantIndexes(conn);await tm.ensure(conn);
 const modules=['mobile_money'];
 const terms=commerce.planSnapshot({...commerce.asPlanVersion({...require('../src/data/store').plans.find(plan=>plan.code==='enterprise'),code:'momo_fx_probe',modules}),status:'published'});
 const tenant=await Tenant.create({name:'Cross currency scratch test',slug,dbName:conn.name,owner:'Owner',email:nonce+'@example.invalid',
  plan:'momo_fx_probe',status:'active',setupStatus:'complete',enabledModules:modules,seatsReserved:2,branchCount:1,
  subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,
   periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const branch=await core.branchModel(conn).create({code:'main',name:'South Sudan exchange test',currency:'SSP',createdBy:owner.id,updatedBy:owner.id});
 for(const actor of [owner,reviewer]){
  actor.branchId=String(branch._id);
  await core.tenantUserModel(conn).create({_id:actor.id,name:actor.name,email:actor.id+'@example.invalid',passwordHash:'isolated-test',
   role:actor.role,branchId:actor.branchId,allowedModules:actor===owner?modules:actor.allowedModules,
   mfaEnabledAt:new Date(),authVersion:0});
 }
 async function opened(kind,code,currency,balance,network=''){
  const account=await treasury.createAccount(conn,tenant,owner,{kind,code,name:'Test '+code,currency,operatorId:owner.id,network});
  const observation=await treasury.requestObservation(conn,tenant,owner,account._id,{
   kind:'opening',actualBalance:balance,observedAt:new Date(Date.now()-5000).toISOString(),
   evidenceType:kind==='cash'?'cash_count':'provider_statement',
   evidenceReference:'TEST-'+code+'-EVIDENCE',
   note:'Independently verified opening funds from isolated synthetic test data',idempotencyKey:crypto.randomUUID()});
  await treasury.reviewObservation(conn,tenant,reviewer,observation.observation._id,{decision:'approve',note:'Independent evidence checked on isolated test accounts'});
  return account;
 }
 const wallet=await opened('wallet','UGX_MTN_FLOAT','UGX','1000','MTN');
 const drawer=await opened('cash','SSP_DRAWER','SSP','500.00');
 const shift=await cash.open(conn,tenant,owner,{currency:'SSP',openingCash:'500.00'});
 await cash.decideOpening(conn,tenant,reviewer,shift._id,{decision:'approve',note:'Physical SSP opening counted independently in test'});
 // The scratch tenant is subscribed to Mobile Money ONLY: no Forex module
 // and no provider or regulatory document workflow.
 for(const [side,quotedRate] of [['buy','900'],['sell','1000']]){
  const rate=await mobileFxRates.setOwnerRate(conn,tenant,owner,branch,{
   fromCurrency:'UGX',toCurrency:'SSP',side,rateBaseUnits:'1000',quotedRate,validHours:'3'});
  assert.equal(rate.status,'active');
  assert.equal(rate.rateDecimal,side==='buy'?'0.9':'1');
 }
 await grants(conn).init();await records(conn).init();
 assert.equal(await grants(conn).countDocuments({tenantId:tenant._id}),0);
 const balances=async()=>({
  wallet:String((await tm.models(conn).account.findById(wallet._id).lean()).bookBalanceMinor),
  drawer:String((await tm.models(conn).account.findById(drawer._id).lean()).bookBalanceMinor)
 });
 async function exercise(operation,amount){
  const q=await preview(conn,tenant,owner,branch,{operation,walletAccountId:String(wallet._id),
   cashAccountId:String(drawer._id),providerAmountMinor:amount});
  const providerReference='TEST-'+crypto.randomBytes(8).toString('hex'),key=crypto.randomUUID();
  const input={...q,branchId:String(branch._id),idempotencyKey:key,providerReference};
  const proof={providerStatus:'confirmed',cashHandoverConfirmed:true,providerReference,
   network:'MTN',currency:'UGX',amountMinor:amount,
   evidenceId:'VERIFIED-'+crypto.randomBytes(8).toString('hex'),
   verifiedAt:new Date().toISOString(),cashConfirmedAt:new Date().toISOString()};
  sign(proof);
  const settled=await settleVerified(conn,tenant,owner,input,proof);
  assert.equal(settled.duplicate,false);
  assert.equal((await settleVerified(conn,tenant,owner,input,proof)).duplicate,true);
  assert.equal((await tm.models(conn).movement.countDocuments({batchId:settled.record.journalBatchId})),2);
  assert.equal((await tm.models(conn).batch.findById(settled.record.journalBatchId)).journalIds.length,2);
  return {q,settled,input,proof};
 }
 assert.deepEqual(await balances(),{wallet:'1000',drawer:'50000'});
 const withdraw=await exercise('withdraw_provider_receive_cash','100');
 assert.equal(withdraw.q.cashAmountMinor,'9000');
 assert.deepEqual(await balances(),{wallet:'1100',drawer:'41000'});
 const deposit=await exercise('deposit_cash_send_provider','50');
 assert.equal(deposit.q.cashAmountMinor,'5000');
 assert.deepEqual(await balances(),{wallet:'1050',drawer:'46000'});
 const manualQuote=await preview(conn,tenant,owner,branch,{operation:'withdraw_provider_receive_cash',
  walletAccountId:String(wallet._id),cashAccountId:String(drawer._id),providerAmountMinor:'10'});
 const manualInput={...manualQuote,branchId:String(branch._id),idempotencyKey:crypto.randomUUID(),
  providerReference:'MANUAL-'+crypto.randomBytes(8).toString('hex'),
  providerAppConfirmed:'yes',cashHandoverConfirmed:'yes'};
 const manual=await settleManuallyConfirmed(conn,tenant,owner,manualInput);
 assert.equal(manual.record.providerSettlementState,'unverified');
 assert.equal(manual.record.providerEvidenceKind,'operator_attested');
 assert.equal(manual.record.providerVerifiedAt,null);
 assert.equal((await settleManuallyConfirmed(conn,tenant,owner,manualInput)).duplicate,true);
 assert.deepEqual(await balances(),{wallet:'1060',drawer:'45100'});

 const beforeSecurityChecks=await balances();
 await assert.rejects(settleVerified(conn,tenant,owner,{
  ...withdraw.input,idempotencyKey:crypto.randomUUID(),
  providerReference:'FORGED-'+nonce
 },{...withdraw.proof,providerReference:'FORGED-'+nonce}),
  error=>error.status===403&&/signature/.test(error.message),
  'a user-edited provider reference must invalidate provider proof');
 await assert.rejects(settleVerified(conn,tenant,owner,{
  ...withdraw.input,idempotencyKey:crypto.randomUUID()
 },withdraw.proof),error=>error.status===409&&/already/.test(error.message),
  'a different request key cannot double-spend the same provider receipt');
 assert.deepEqual(await balances(),beforeSecurityChecks,'forged or replayed provider receipts must never move custody');
 assert.equal(await records(conn).countDocuments({tenantId:tenant._id}),3);
 for(const currency of ['UGX','SSP'])
  assert.equal((await require('../src/tenant/services/ledger.service').trialBalance(conn,{branchId:branch._id,currency})).balanced,true);
 const bad=await preview(conn,tenant,owner,branch,{operation:'withdraw_provider_receive_cash',walletAccountId:String(wallet._id),
  cashAccountId:String(drawer._id),providerAmountMinor:'1000'});
 const existingBalance=await balances(),originalCount=await records(conn).countDocuments();
 const insufficientInput={...bad,branchId:String(branch._id),idempotencyKey:crypto.randomUUID(),providerReference:'INSUFFICIENT-'+nonce};
 const insufficientProof=sign({providerStatus:'confirmed',cashHandoverConfirmed:true,
  providerReference:'INSUFFICIENT-'+nonce,network:'MTN',currency:'UGX',amountMinor:'1000',
  evidenceId:'INSUFFICIENT-EVIDENCE-'+nonce,verifiedAt:new Date().toISOString(),cashConfirmedAt:new Date().toISOString()});
 await assert.rejects(settleVerified(conn,tenant,owner,insufficientInput,insufficientProof),
  error=>error.status===409&&/Insufficient/.test(error.message));

 assert.deepEqual(await balances(),existingBalance,'both custody movements must roll back together');
 assert.equal(await records(conn).countDocuments(),originalCount,'failed exchange cannot appear settled');
 assert.equal(await tm.models(conn).batch.countDocuments({sourceRef:{$regex:/^MFX:/}}),3,'failed exchange cannot create a journal batch');
 // Explicit legacy suspension still fences future posts even though
 // ordinary internal book recording no longer requires document grants.
 const [suspended]=await grants(conn).create([{
  tenantId:tenant._id,branchId:branch._id,walletAccountId:wallet._id,cashAccountId:drawer._id,
  providerNetwork:'MTN',permittedCurrencyPair:'UGX/SSP',status:'suspended',
  providerAuthorizationReference:'LEGACY-SUSPENDED-PAIR',
  regulatoryAuthorizationReference:'LEGACY-SUSPENDED-PAIR',
  expiresAt:new Date(Date.now()+86400000)
 }]);
 const afterSuspendQuote=await preview(conn,tenant,owner,branch,{operation:'withdraw_provider_receive_cash',
  walletAccountId:String(wallet._id),cashAccountId:String(drawer._id),providerAmountMinor:'1'});
 await assert.rejects(settleManuallyConfirmed(conn,tenant,owner,{
  ...afterSuspendQuote,branchId:String(branch._id),idempotencyKey:crypto.randomUUID(),
  providerReference:'SUSPENDED-'+nonce,providerAppConfirmed:'yes',cashHandoverConfirmed:'yes'
 }),error=>error.status===403&&/hold|suspend/.test(error.message),
 'suspended provider grant must prevent all future cross-currency postings');
 assert.deepEqual(await balances(),existingBalance,'suspended authorization must not move money');
 console.log('PASS: Mobile Money-only entitlement without document grants, owner 1,000-unit FX rates, opposite UGX/SSP cash directions, atomic native-currency journals, duplicate protection, insufficient-funds rollback, suspended pair hold and unmeasured FX profit.');
}
async function cleanup(){
 if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_momofx_[a-f0-9]{14}$/.test(platformName)){
  if(conn?.name===require('../src/config/tenantDatabaseName').tenantDbNameFromSlug(slug))await conn.db.dropDatabase();
  await mongoose.connection.db.dropDatabase();
 }
 await mongoose.disconnect();
}
main().catch(e=>{console.error('MOMO FX INTEGRATION FAILED:',e.stack||e.message);process.exitCode=1;})
 .finally(()=>cleanup().catch(e=>{console.error('MOMO FX CLEANUP FAILED:',e.message);process.exitCode=1;}));
