#!/usr/bin/env node
'use strict';
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Mobile funds integration requires an isolated local replica set');
const nonce=crypto.randomBytes(7).toString('hex'),platformName=`cfh_mobile_funds_${nonce}`,slug=`mobile-funds-${nonce}`;configured.pathname='/'+platformName;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose'),core=require('../src/tenant/models'),Tenant=require('../src/platform/models/Tenant'),Usage=require('../src/platform/models/UsageCounter');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo'),commerce=require('../src/platform/services/commercial.service'),{permissionsFor}=require('../src/config/roles');
const treasury=require('../src/tenant/treasury/service'),funds=require('../src/tenant/treasury/models'),mobile=require('../src/tenant/services/mobileMoney.service'),cash=require('../src/tenant/services/cashDrawer.service');
let conn;const id=()=>String(new mongoose.Types.ObjectId()),owner={id:id(),name:'Funds Owner',role:'Tenant Owner',permissions:['*'],authVersion:0},operator={id:id(),name:'Actual Operator',role:'Mobile Money Operator',permissions:permissionsFor('Mobile Money Operator'),allowedModules:['mobile_money','accounts'],authVersion:0},reviewer={id:id(),name:'Independent Reviewer',role:'Reconciliation Officer',permissions:permissionsFor('Reconciliation Officer'),allowedModules:['mobile_money','accounts'],authVersion:0};
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),Usage.createIndexes()]);conn=getTenantConnection(slug);await core.ensureTenantIndexes(conn);await funds.ensure(conn);
 const modules=['mobile_money','accounts','customers','banking','forex','money_transfer','expenses'],terms=commerce.planSnapshot({...commerce.asPlanVersion({...require('../src/data/store').plans.find(plan=>plan.code==='enterprise'),code:'mobile_funds_probe',modules}),status:'published'});
 const tenant=await Tenant.create({name:'Mobile funds proof',slug,dbName:conn.name,owner:'Owner',email:`${nonce}@example.invalid`,plan:'mobile_funds_probe',status:'active',setupStatus:'complete',enabledModules:modules,seatsReserved:3,branchCount:1,subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const branch=await core.branchModel(conn).create({code:'main',name:'Actual branch',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
 for(const actor of [owner,operator,reviewer]){actor.branchId=String(branch._id);await core.tenantUserModel(conn).create({_id:actor.id,name:actor.name,email:`${actor.id}@example.invalid`,passwordHash:'isolated-only',role:actor.role,branchId:actor.branchId,allowedModules:actor.allowedModules||modules,authVersion:0,...(actor===operator?{}:{mfaEnabledAt:new Date()})});}
 async function open(kind,code,balance,network=''){
  const account=await treasury.createAccount(conn,tenant,owner,{kind,code,name:'Actual '+code,currency:'UGX',operatorId:operator.id,network});
  const request=await treasury.requestObservation(conn,tenant,operator,account._id,{kind:'opening',actualBalance:String(balance),observedAt:new Date(Date.now()-1000).toISOString(),evidenceType:kind==='cash'?'cash_count':kind==='wallet'?'provider_statement':'bank_statement',evidenceReference:'ACTUAL-'+code+'-STATEMENT',note:'Actual balance inspected directly before opening the funds book',idempotencyKey:crypto.randomUUID()});
  await treasury.reviewObservation(conn,tenant,reviewer,request.observation._id,{decision:'approve',note:'Independent opening source and exact balance inspected'});return account;
 }
 const wallet=await open('wallet','MTN_FLOAT',1000000,'MTN'),drawer=await open('cash','PHYSICAL_CASH',500000),bank=await open('bank','BANK_FUNDS',300000);
 const shift=await cash.open(conn,tenant,operator,{openingCash:'500000'});await cash.decideOpening(conn,tenant,reviewer,shift._id,{decision:'approve',note:'Opening physical count matches the reviewed cash account'});
 const base={customer:'Actual Customer',customerPhone:'+256700123456',network:'MTN',currency:'UGX',walletAccountId:String(wallet._id),paymentAccountId:String(drawer._id),paymentMethod:'Cash',fee:'0',feeTreatment:'record_only'};
 const request=(operation,amount,observed,extra={})=>({...base,operation,amount:String(amount),observedWalletBalance:String(observed),networkReference:'ACTUAL-'+crypto.randomBytes(8).toString('hex'),idempotencyKey:crypto.randomUUID(),...extra});
 async function record(input){return mobile.recordMobileMoney(conn,operator,input,input.operation,tenant,null,{requireFunds:true});}
 async function accept(recorded){return mobile.reviewMobileMoney(conn,reviewer,recorded.created._id,'accepted','Provider evidence, actual wallet and recorded payment checked independently');}
 async function balance(account){return String((await funds.models(conn).account.findById(account._id).lean()).bookBalanceMinor);}
 await treasury.configureAccount(conn,tenant,owner,wallet._id,{name:wallet.name,isDefault:'true',feeTreatment:'payment_collected'});
 const firstInput=request('cash_in',10000,990000,{fee:'100',feeTreatment:'payment_collected'}),first=await record(firstInput);
 assert.equal(first.created.fundingState,'book_recorded');assert.equal(String(first.created.physicalCashMovementMinor),'10100');assert.equal(await balance(wallet),'990000');assert.equal(await balance(drawer),'510100');assert.equal((await record(firstInput)).duplicate,true);
 await assert.rejects(record({...firstInput,feeTreatment:'record_only'}),{status:409});await accept(first);
 const firstObservation=await funds.models(conn).observation.findById(first.created.walletObservationId).lean();assert.equal(firstObservation.status,'approved');assert.equal(String(firstObservation.varianceMinorAtReview),'0');
 await treasury.configureAccount(conn,tenant,owner,wallet._id,{name:wallet.name,isDefault:'true',feeTreatment:'wallet_commission'});
 const second=await record(request('cash_out',5000,995050,{fee:'50',feeTreatment:'wallet_commission'}));await accept(second);assert.equal(await balance(wallet),'995050');assert.equal(await balance(drawer),'505100');
 await treasury.configureAccount(conn,tenant,owner,wallet._id,{name:wallet.name,isDefault:'true',feeTreatment:'record_only'});
 const third=await record(request('cash_in',2000,993050,{paymentMethod:'Bank',paymentAccountId:String(bank._id)}));await accept(third);assert.equal(await balance(bank),'302000');assert.equal(await balance(wallet),'993050');
 const usageBefore=(await Usage.findOne({tenantId:tenant._id,metric:'mobile_money_records'})).quantity,countBefore=await core.mobileTransactionModel(conn).countDocuments(),auditBefore=await core.auditEventModel(conn).countDocuments();
 await assert.rejects(record(request('cash_in',2000000,0)),error=>error.status===409&&/Insufficient/.test(error.message));
 assert.equal((await Usage.findOne({tenantId:tenant._id,metric:'mobile_money_records'})).quantity,usageBefore);assert.equal(await core.mobileTransactionModel(conn).countDocuments(),countBefore);assert.equal(await core.auditEventModel(conn).countDocuments(),auditBefore);assert.equal(await balance(wallet),'993050');
 const wrong=await record(request('cash_in',1000,992000));assert.equal(await balance(wallet),'992050');assert.equal((await funds.models(conn).account.findById(wallet._id)).status,'held');
 await assert.rejects(record(request('cash_in',1,991999)),{status:409});await accept(wrong);assert.equal((await funds.models(conn).account.findById(wallet._id)).status,'held');
 const adjustment=await treasury.requestAdjustment(conn,tenant,operator,wrong.created.walletObservationId,{reason:'Investigated the actual provider statement and documented the remaining fifty-unit variance',idempotencyKey:crypto.randomUUID()});await treasury.reviewAdjustment(conn,tenant,reviewer,adjustment.adjustment._id,{decision:'approve',note:'Independent evidence confirms the fifty-unit reconciliation adjustment'});assert.equal(await balance(wallet),'992000');
 const corrected=await record(request('cash_out',100,992100));await accept(corrected);await mobile.requestVoid(conn,operator,corrected.created._id,'The manual cash-out was an incorrect duplicate instruction');await mobile.decideVoid(conn,reviewer,corrected.created._id,'approve','Original wallet and cash evidence confirms the internal void');assert.equal(await balance(wallet),'992000');assert.equal(await balance(drawer),'506100');
 await cash.submit(conn,tenant,operator,shift._id,{countedCash:'506100',note:'Counted physical closing cash agrees with all reviewed movements'});const submitted=await core.cashSessionModel(conn).findById(shift._id).lean();assert(submitted.treasuryObservationId);await cash.decide(conn,tenant,reviewer,shift._id,{decision:'approve',note:'Independent closing count and source ledger are in agreement'});assert.equal((await funds.models(conn).account.findById(drawer._id)).lastObservedMinor.toString(),'506100');
 assert.equal((await require('../src/tenant/services/ledger.service').trialBalance(conn,{branchId:branch._id,currency:'UGX'})).balanced,true);
 const viewer=mobile.visibleRecordForRole(first.created.toObject?first.created.toObject():first.created,'Viewer');assert.equal(viewer.walletBalanceAfterMinor,undefined);
 const context=await require('../src/tenant/services/mobileMoneyFunds.service').context(conn,tenant,operator,branch);assert(context.wallets.some(row=>row.id===String(wallet._id)&&row.expected==='UGX 992,000'));assert(context.paymentAccounts.some(row=>row.id===String(drawer._id)&&row.expected==='UGX 506,100'));
 await treasury.configureAccount(conn,tenant,owner,wallet._id,{name:wallet.name,isDefault:'true',feeTreatment:'wallet_commission'});
 const dailyInput=request('cash_in',100,0,{paymentMethod:'Bank',fee:'25'});
 for(const field of ['observedWalletBalance','observationEvidenceReference','feeTreatment','paymentAccountId','walletAccountId'])delete dailyInput[field];
 const daily=await record(dailyInput);
 assert.equal(daily.created.fundingState,'book_recorded');assert.equal(daily.created.feeTreatment,'wallet_commission');assert.equal(daily.created.walletObservationId,null,'daily entries do not require a repeated actual balance declaration');
 assert.equal(String(daily.created.walletAccountId),String(wallet._id));assert.equal(String(daily.created.paymentAccountId),String(bank._id));
 assert.equal(await balance(wallet),'991925');assert.equal(await balance(bank),'302100');
 await treasury.configureAccount(conn,tenant,owner,wallet._id,{name:wallet.name,isDefault:'true',feeTreatment:'record_only'});
 const dailyCount=await core.mobileTransactionModel(conn).countDocuments();
 assert.equal((await record(dailyInput)).duplicate,true,'retry keeps the original wallet policy even after its configuration changes');
 assert.equal(await core.mobileTransactionModel(conn).countDocuments(),dailyCount);assert.equal(await balance(wallet),'991925');
 await assert.rejects(record({...dailyInput,feeTreatment:'record_only'}),{status:409},'an explicit changed fee treatment cannot reuse the posted reference');
 const changedPolicy={...dailyInput,idempotencyKey:crypto.randomUUID(),networkReference:'POLICY-'+crypto.randomBytes(8).toString('hex'),walletFeePolicy:'wallet_commission'};
 await assert.rejects(record(changedPolicy),error=>error.status===409&&/settings changed|policy changed/i.test(error.message),'a changed wallet policy cannot silently change the customer preview');
 assert.equal(await core.mobileTransactionModel(conn).countDocuments(),dailyCount);assert.equal(await balance(wallet),'991925');assert.equal(await balance(bank),'302100');
 await assert.rejects(record({...changedPolicy,idempotencyKey:crypto.randomUUID(),networkReference:'FORGED-'+crypto.randomBytes(8).toString('hex'),walletFeePolicy:'record_only',feeTreatment:'payment_collected'}),error=>error.status===409&&/configured.*Wallets/i.test(error.message),'ordinary daily posts cannot override the configured wallet policy');
 assert.equal(await core.mobileTransactionModel(conn).countDocuments(),dailyCount);assert.equal(await balance(bank),'302100');
 assert.equal((await require('../src/tenant/services/ledger.service').trialBalance(conn,{branchId:branch._id,currency:'UGX'})).balanced,true);
 console.log('PASS: Configured wallet/payment defaults, daily entries without repeated balance setup, configured fee policy and idempotency, exact funds and balanced journals, optional actual evidence, mismatch holds/adjustments, insufficient-float rollback, inverse corrections, cash close and privacy.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_mobile_funds_[a-f0-9]{14}$/.test(platformName)){if(conn)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('MOBILE FUNDS INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Mobile funds cleanup failed:',error.message);process.exitCode=1;}));
