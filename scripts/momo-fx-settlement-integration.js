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
const mongoose=require('mongoose'),core=require('../src/tenant/models');
const Tenant=require('../src/platform/models/Tenant'),Usage=require('../src/platform/models/UsageCounter');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const commerce=require('../src/platform/services/commercial.service');
const treasury=require('../src/tenant/treasury/service'),tm=require('../src/tenant/treasury/models');
const forex=require('../src/tenant/services/forex.service');
const {preview}=require('../src/tenant/services/momoFxPreview.service');
const {settleVerified}=require('../src/tenant/services/momoFxSettlement.service');
const {records,grants}=require('../src/tenant/schemas/MomoFxSettlement');
const cash=require('../src/tenant/services/cashDrawer.service');
const {permissionsFor}=require('../src/config/roles');
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
 const modules=['mobile_money','forex','money_transfer','banking','expenses'];
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
 for(const [side,rateDecimal] of [['buy','0.9'],['sell','1.0']]){
  const proposed=await forex.proposeRate(conn,tenant,owner,{fromCurrency:'UGX',toCurrency:'SSP',side,rateDecimal,validHours:3,note:'Synthetic approved cross-currency rate with verified direction'});
  await forex.decideRate(conn,tenant,reviewer,proposed._id,{decision:'approve',note:'Approved independent synthetic bid or ask reference'});
 }
 await grants(conn).init();await records(conn).init();
 await grants(conn).create({tenantId:tenant._id,branchId:branch._id,
  walletAccountId:wallet._id,cashAccountId:drawer._id,providerNetwork:'MTN',
  status:'approved',permittedCurrencyPair:'UGX/SSP',
  providerAuthorizationReference:'ISOLATED-TEST-ONLY-PROVIDER-CONTRACT',
  regulatoryAuthorizationReference:'ISOLATED-TEST-ONLY-LICENSE',
  approvedBy:reviewer.id,reviewedAt:new Date(),expiresAt:new Date(Date.now()+86400000)});
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
 assert.equal(await records(conn).countDocuments({tenantId:tenant._id}),2);
 for(const currency of ['UGX','SSP'])
  assert.equal((await require('../src/tenant/services/ledger.service').trialBalance(conn,{branchId:branch._id,currency})).balanced,true);
 const bad=await preview(conn,tenant,owner,branch,{operation:'withdraw_provider_receive_cash',walletAccountId:String(wallet._id),
  cashAccountId:String(drawer._id),providerAmountMinor:'1000'});
 const existingBalance=await balances(),originalCount=await records(conn).countDocuments();
 await assert.rejects(settleVerified(conn,tenant,owner,{...bad,branchId:String(branch._id),
  idempotencyKey:crypto.randomUUID(),providerReference:'INSUFFICIENT-'+nonce},{
   providerStatus:'confirmed',cashHandoverConfirmed:true,
   providerReference:'INSUFFICIENT-'+nonce,network:'MTN',currency:'UGX',amountMinor:'1000',
   evidenceId:'INSUFFICIENT-EVIDENCE-'+nonce,verifiedAt:new Date().toISOString(),cashConfirmedAt:new Date().toISOString()
  }),error=>error.status===409&&/Insufficient/.test(error.message));
 assert.deepEqual(await balances(),existingBalance,'both custody movements must roll back together');
 assert.equal(await records(conn).countDocuments(),originalCount,'failed exchange cannot appear settled');
 assert.equal(await tm.models(conn).batch.countDocuments({sourceRef:{$regex:/^MFX:/}}),2,'failed exchange cannot create a journal batch');
 console.log('PASS: approved bid/ask quote, opposite UGX/SSP cash directions, atomic native-currency journals, no duplicate settlement, insufficient-cash rollback, and truthful unmeasured FX profit.');
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
