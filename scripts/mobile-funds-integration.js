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
 async function open(kind,code,balance,network='',currency='UGX'){
  const account=await treasury.createAccount(conn,tenant,owner,{kind,code,name:'Actual '+code,currency,operatorId:operator.id,network});
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
 await assert.rejects(treasury.configureAccount(conn,tenant,owner,wallet._id,{name:wallet.name,isDefault:'true',feeTreatment:'wallet_commission'}),{status:400},'Speculative commission policies cannot be enabled for new transactions');
 const second=await record(request('cash_out',5000,995000,{fee:'0',feeTreatment:'payment_collected'}));await accept(second);assert.equal(await balance(wallet),'995000');assert.equal(await balance(drawer),'505100');
 await treasury.configureAccount(conn,tenant,owner,wallet._id,{name:wallet.name,isDefault:'true',feeTreatment:'record_only'});
 const third=await record(request('cash_in',2000,993000,{paymentMethod:'Cash',paymentAccountId:String(drawer._id),feeTreatment:'record_only'}));await accept(third);assert.equal(await balance(drawer),'507100');assert.equal(await balance(wallet),'993000');
 await assert.rejects(record(request('cash_in',1000,0,{paymentMethod:'Bank',paymentAccountId:String(bank._id)})),{status:400},'New agent entries use physical cash, not bank or customer-wallet payments');
 const usageBefore=(await Usage.findOne({tenantId:tenant._id,metric:'mobile_money_records'})).quantity,countBefore=await core.mobileTransactionModel(conn).countDocuments(),auditBefore=await core.auditEventModel(conn).countDocuments();
 await assert.rejects(record(request('cash_in',2000000,0)),error=>error.status===409&&/Insufficient/.test(error.message));
 assert.equal((await Usage.findOne({tenantId:tenant._id,metric:'mobile_money_records'})).quantity,usageBefore);assert.equal(await core.mobileTransactionModel(conn).countDocuments(),countBefore);assert.equal(await core.auditEventModel(conn).countDocuments(),auditBefore);assert.equal(await balance(wallet),'993000');
 const wrong=await record(request('cash_in',1000,991950));assert.equal(await balance(wallet),'992000');assert.equal((await funds.models(conn).account.findById(wallet._id)).status,'held');
 await assert.rejects(record(request('cash_in',1,991999)),{status:409});await accept(wrong);assert.equal((await funds.models(conn).account.findById(wallet._id)).status,'held');
 const adjustment=await treasury.requestAdjustment(conn,tenant,operator,wrong.created.walletObservationId,{reason:'Investigated the actual provider statement and documented the remaining fifty-unit variance',idempotencyKey:crypto.randomUUID()});await treasury.reviewAdjustment(conn,tenant,reviewer,adjustment.adjustment._id,{decision:'approve',note:'Independent evidence confirms the fifty-unit reconciliation adjustment'});assert.equal(await balance(wallet),'991950');
 const corrected=await record(request('cash_out',100,992050));await accept(corrected);await mobile.requestVoid(conn,operator,corrected.created._id,'The manual cash-out was an incorrect duplicate instruction');await mobile.decideVoid(conn,reviewer,corrected.created._id,'approve','Original wallet and cash evidence confirms the internal void');assert.equal(await balance(wallet),'991950');assert.equal(await balance(drawer),'508100');
 await cash.submit(conn,tenant,operator,shift._id,{countedCash:'508100',note:'Counted physical closing cash agrees with all reviewed movements'});const submitted=await core.cashSessionModel(conn).findById(shift._id).lean();assert(submitted.treasuryObservationId);await cash.decide(conn,tenant,reviewer,shift._id,{decision:'approve',note:'Independent closing count and source ledger are in agreement'});assert.equal((await funds.models(conn).account.findById(drawer._id)).lastObservedMinor.toString(),'508100');
 assert.equal((await require('../src/tenant/services/ledger.service').trialBalance(conn,{branchId:branch._id,currency:'UGX'})).balanced,true);
 const viewer=mobile.visibleRecordForRole(first.created.toObject?first.created.toObject():first.created,'Viewer');assert.equal(viewer.walletBalanceAfterMinor,undefined);
 const context=await require('../src/tenant/services/mobileMoneyFunds.service').context(conn,tenant,operator,branch);assert(context.wallets.some(row=>row.id===String(wallet._id)&&row.expected==='UGX 991,950'));assert(context.paymentAccounts.some(row=>row.id===String(drawer._id)&&row.expected==='UGX 508,100'));
 const newShift=await cash.open(conn,tenant,operator,{openingCash:'508100'});await cash.decideOpening(conn,tenant,reviewer,newShift._id,{decision:'approve',note:'Independent next shift opening cash matches the Treasury cash account'});
 const dailyInput=request('cash_in',100,0,{paymentMethod:'Cash',fee:'0'});
 for(const field of ['observedWalletBalance','observationEvidenceReference','feeTreatment','paymentAccountId','walletAccountId'])delete dailyInput[field];
 const daily=await record(dailyInput);
 assert.equal(daily.created.fundingState,'book_recorded');assert.equal(daily.created.feeTreatment,'record_only');assert.equal(daily.created.walletObservationId,null,'daily entries do not require a repeated actual balance declaration');
 assert.equal(String(daily.created.walletAccountId),String(wallet._id));assert.equal(String(daily.created.paymentAccountId),String(drawer._id));
 assert.equal(await balance(wallet),'991850');assert.equal(await balance(drawer),'508200');
 await treasury.configureAccount(conn,tenant,owner,wallet._id,{name:wallet.name,isDefault:'true',feeTreatment:'record_only'});
 const dailyCount=await core.mobileTransactionModel(conn).countDocuments();
 assert.equal((await record(dailyInput)).duplicate,true,'retry keeps the original wallet policy even after its configuration changes');
 assert.equal(await core.mobileTransactionModel(conn).countDocuments(),dailyCount);assert.equal(await balance(wallet),'991850');assert.equal(await balance(drawer),'508200');
 await assert.rejects(record({...dailyInput,feeTreatment:'payment_collected'}),{status:409},'a changed fee treatment cannot reuse the posted operation reference');
 const changedPolicy={...dailyInput,idempotencyKey:crypto.randomUUID(),networkReference:'POLICY-'+crypto.randomBytes(8).toString('hex'),walletFeePolicy:'payment_collected'};
 await assert.rejects(record(changedPolicy),error=>error.status===409&&/settings changed|policy changed/i.test(error.message),'a changed wallet policy cannot silently change the customer preview');
 assert.equal(await core.mobileTransactionModel(conn).countDocuments(),dailyCount);assert.equal(await balance(wallet),'991850');assert.equal(await balance(drawer),'508200');
 await assert.rejects(record({...changedPolicy,idempotencyKey:crypto.randomUUID(),networkReference:'FORGED-'+crypto.randomBytes(8).toString('hex'),walletFeePolicy:'record_only',feeTreatment:'payment_collected'}),error=>error.status===409&&/configured.*Wallets/i.test(error.message),'ordinary daily posts cannot override the configured wallet policy');
 assert.equal(await core.mobileTransactionModel(conn).countDocuments(),dailyCount);assert.equal(await balance(drawer),'508200');
 assert.equal((await require('../src/tenant/services/ledger.service').trialBalance(conn,{branchId:branch._id,currency:'UGX'})).balanced,true);
 // One branch/operator keeps independent exact cash and network books in
 // multiple selected currencies. MTN SSD never shares MTN's reference space.
 const usdWallet=await open('wallet','USD_AFRICELL_FLOAT','1000.25','Africell','USD'),usdCash=await open('cash','USD_PHYSICAL_CASH','500.00','','USD');
 const sspWallet=await open('wallet','SSP_MTN_SSD_FLOAT','2000.50','MTN SSD','SSP'),sspCash=await open('cash','SSP_PHYSICAL_CASH','700.00','','SSP');
 const multiShifts={};
 for(const [currency,openingCash] of [['USD','500.00'],['SSP','700.00']]){
  const opened=await cash.open(conn,tenant,operator,{currency,openingCash});
  await cash.decideOpening(conn,tenant,reviewer,opened._id,{decision:'approve',note:'Independent physical currency-specific opening count agrees with its recorded funds book'});multiShifts[currency]=opened;
 }
 assert.notEqual(multiShifts.USD.activeKey,multiShifts.SSP.activeKey);
 const beforeUgx=await balance(wallet),beforeUgxCash=await balance(drawer),sameReference='MULTI-NETWORK-'+nonce;
 const usdInput={...base,currency:'USD',network:'Africell',walletAccountId:String(usdWallet._id),paymentAccountId:String(usdCash._id),operation:'cash_in',amount:'10.25',fee:'0',networkReference:sameReference,idempotencyKey:crypto.randomUUID()};
 const usd=await record(usdInput);await accept(usd);
 const sspInput={...base,currency:'SSP',network:'MTN SSD',walletAccountId:String(sspWallet._id),paymentAccountId:String(sspCash._id),operation:'cash_in',amount:'20.05',fee:'0',networkReference:sameReference,idempotencyKey:crypto.randomUUID()};
 const ssp=await record(sspInput);await accept(ssp);
 assert.equal(String(usd.created.cashSessionId),String(multiShifts.USD._id));assert.equal(String(ssp.created.cashSessionId),String(multiShifts.SSP._id));
 assert.equal(await balance(usdWallet),'99000');assert.equal(await balance(usdCash),'51025');assert.equal(await balance(sspWallet),'198045');assert.equal(await balance(sspCash),'72005');
 assert.equal(await balance(wallet),beforeUgx);assert.equal(await balance(drawer),beforeUgxCash);
 assert.equal((await record(sspInput)).duplicate,true);
 await assert.rejects(record({...sspInput,idempotencyKey:crypto.randomUUID(),networkReference:'CROSS-CURRENCY-'+nonce,paymentAccountId:String(usdCash._id)}),{status:409});
 await assert.rejects(record({...sspInput,idempotencyKey:crypto.randomUUID(),networkReference:'CROSS-NETWORK-'+nonce,walletAccountId:String(usdWallet._id)}),{status:409});
 const allFunds=await require('../src/tenant/services/mobileMoneyFunds.service').context(conn,tenant,operator,branch);
 assert(allFunds.wallets.some(row=>row.network==='MTN SSD'&&row.currency==='SSP'));assert(allFunds.wallets.some(row=>row.network==='Africell'&&row.currency==='USD'));
 // Real Mongo aggregation of unified report across independent currencies.
 // Commission estimates cannot masquerade as actual received payouts.
 const report=await require('../src/tenant/services/mobileMoneyUnifiedReport.service').generate(conn,tenant,operator,{period:'year'});
 for(const [network,currency] of [['MTN','UGX'],['Africell','USD'],['MTN SSD','SSP']])
  assert(report.networks.some(row=>row.network===network&&row.currency===currency),'Missing reported '+network+' / '+currency);
 assert.equal(report.currencies.find(row=>row.currency==='UGX').receivedCommissionMinor,0n);
 assert(report.currencies.find(row=>row.currency==='UGX').voidedCount>=1);
 const scoped=await require('../src/tenant/services/mobileMoneyWorkspace.service').workspace(conn,operator,{network:'MTN SSD',currency:'SSP'});
 assert.equal(scoped.summary.activeCount,1);assert.equal(scoped.summary.byCurrency[0].currency,'SSP');assert.equal(scoped.networks[0].network,'MTN SSD');
 await mobile.requestVoid(conn,operator,ssp.created._id,'The SSP cash-in was entered against the wrong physical instruction');
 await mobile.decideVoid(conn,reviewer,ssp.created._id,'approve','Independent SSP receipt and drawer evidence authorizes the exact SSP-only reversal');
 assert.equal(await balance(sspWallet),'200050');assert.equal(await balance(sspCash),'70000');assert.equal(await balance(usdCash),'51025');
 for(const currency of ['USD','SSP'])assert.equal((await require('../src/tenant/services/ledger.service').trialBalance(conn,{branchId:branch._id,currency})).balanced,true);
 await core.branchModel(conn).updateOne({_id:branch._id},{$set:{currencies:['UGX','USD']}});
 await assert.rejects(record({...sspInput,idempotencyKey:crypto.randomUUID(),networkReference:'DISABLED-CURRENCY-'+nonce}),{status:409});
 await assert.rejects(open('bank','DISABLED_SSP_BANK','1.00','','SSP'),{status:409});
 // Rejecting duplicate evidence must precede unused-wallet archival.
 const duplicate=await treasury.createAccount(conn,tenant,owner,{
  kind:'wallet',code:'DUPLICATE_MTN',name:'Incorrect duplicate MTN float',
  currency:'UGX',network:'MTN',operatorId:operator.id,isDefault:false
 });
 const wrongOpening=await treasury.requestObservation(conn,tenant,operator,duplicate._id,{
  kind:'opening',actualBalance:'2000000',observedAt:new Date(Date.now()-1000).toISOString(),
  evidenceType:'provider_app',evidenceReference:'DUPLICATE-STATEMENT-'+nonce,
  note:'Duplicate wallet opening recorded in error for review',idempotencyKey:crypto.randomUUID()
 });
 await assert.rejects(treasury.archiveUnusedWallet(conn,tenant,owner,duplicate._id,{
  confirmCode:'DUPLICATE_MTN',reason:'Archive the wrong duplicate only after independent opening rejection'
 }),{status:409});
 await treasury.reviewObservation(conn,tenant,reviewer,wrongOpening.observation._id,{
  decision:'reject',note:'Wrong duplicate wallet has no independently recognized opening'
 });
 await assert.rejects(treasury.archiveUnusedWallet(conn,tenant,reviewer,duplicate._id,{
  confirmCode:'DUPLICATE_MTN',reason:'This role is not authorized to archive the wallet'
 }),{status:403});
 const archived=await treasury.archiveUnusedWallet(conn,tenant,owner,duplicate._id,{
  confirmCode:'DUPLICATE_MTN',reason:'Incorrect duplicated MTN account; original provider wallet retained'
 });
 assert.equal(archived.status,'archived');
 assert.equal((await funds.models(conn).observation.findById(wrongOpening.observation._id)).status,'rejected');
 assert(!(await treasury.findOperatingAccounts(conn,tenant,owner,{branchId:String(branch._id)})).some(row=>String(row._id)===String(duplicate._id)));
 await assert.rejects(treasury.archiveUnusedWallet(conn,tenant,owner,wallet._id,{
  confirmCode:wallet.code,reason:'Attempt to archive a funded operational wallet must be blocked'
 }),{status:409});
 assert(await core.auditEventModel(conn).exists({action:'treasury.account.archived',targetId:duplicate._id}));
 console.log('PASS: Agent cash/float journals, cash-only new operation policy, no speculative commissions, configured fees, idempotency, exact reconciliation, safe voids and shift closure.');
 console.log('PASS: One branch/operator posts USD and SSP independently; MTN SSD preserves its own network references, wallets, verified shifts, exact cents, scoped reports and reversal. Wrong currency/network accounts and disabled currencies are rejected without changing other books.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_mobile_funds_[a-f0-9]{14}$/.test(platformName)){if(conn)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('MOBILE FUNDS INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Mobile funds cleanup failed:',error.message);process.exitCode=1;}));
