#!/usr/bin/env node
'use strict';
// Real services and transactions; only disposable random loopback databases.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Branch multicurrency integration requires a single unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),platformName=`cfh_branch_ccy_${nonce}`,slug=`branch-ccy-${nonce}`;
configured.pathname='/'+platformName;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose'),core=require('../src/tenant/models');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const Tenant=require('../src/platform/models/Tenant'),commerce=require('../src/platform/services/commercial.service');
const branches=require('../src/tenant/services/branch.service'),policy=require('../src/tenant/services/branchCurrency.service'),cash=require('../src/tenant/services/cashDrawer.service');
const mobile=require('../src/tenant/services/mobileMoney.service'),ledger=require('../src/tenant/services/ledger.service'),banking=require('../src/tenant/services/banking.service'),transfer=require('../src/tenant/services/moneyTransfer.service'),forex=require('../src/tenant/services/forex.service');
const {permissionsFor}=require('../src/config/roles');
let conn;
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Tenant.createIndexes();await require('../src/platform/models/UsageCounter').createIndexes();conn=getTenantConnection(slug);await core.ensureTenantIndexes(conn);
 const owner={id:String(new mongoose.Types.ObjectId()),role:'Tenant Owner',permissions:['*'],authVersion:0};
 const reviewer={id:String(new mongoose.Types.ObjectId()),role:'Reconciliation Officer',permissions:permissionsFor('Reconciliation Officer'),allowedModules:['mobile_money','money_transfer','banking','forex'],authVersion:0};
 for(const actor of [owner,reviewer])await core.tenantUserModel(conn).create({_id:actor.id,name:actor.role,email:`${actor.id}@example.invalid`,passwordHash:'isolated-test-only',role:actor.role,allowedModules:actor.allowedModules||[],mfaEnabledAt:new Date(),authVersion:0});
 const snapshot=commerce.planSnapshot({...commerce.asPlanVersion(require('../src/data/store').plans.find(plan=>plan.code==='enterprise')),status:'published'});
 const tenant=await Tenant.create({name:'Branch multicurrency proof',slug,dbName:conn.name,owner:'Owner',email:`${nonce}@example.invalid`,plan:snapshot.planCode,status:'active',setupStatus:'complete',enabledModules:snapshot.modules,seatsReserved:2,branchCount:0,subscription:{...snapshot,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const branch=await branches.create(tenant,owner,{name:'Main multicurrency',code:'main',currency:'UGX'});owner.branchId=reviewer.branchId=String(branch._id);await core.tenantUserModel(conn).updateOne({_id:reviewer.id},{$set:{branchId:reviewer.branchId}});
 const destinationBranch=await branches.create(tenant,owner,{name:'Receiving multicurrency',code:'receiving',currency:'UGX'});
 assert.deepEqual(policy.supported(branch),['UGX','USD','SSP','KES']);
 const opened=new Map();
 const ugx=await cash.open(conn,tenant,owner,{currency:'UGX',openingCash:'500'});opened.set('UGX',ugx);
 // Reproduce a pre-upgrade unfinished row with the old key.
 await core.cashSessionModel(conn).collection.updateOne({_id:ugx._id},{$set:{activeKey:cash.key(branch._id,owner.id)}});
 await assert.rejects(cash.open(conn,tenant,owner,{currency:'UGX',openingCash:'500'}),{status:409});
 const contenders=await Promise.allSettled([cash.open(conn,tenant,owner,{currency:'USD',openingCash:'500.00'}),cash.open(conn,tenant,owner,{currency:'USD',openingCash:'500.00'})]);
 assert.equal(contenders.filter(row=>row.status==='fulfilled').length,1);assert.equal(contenders.filter(row=>row.status==='rejected'&&row.reason.status===409).length,1);opened.set('USD',contenders.find(row=>row.status==='fulfilled').value);
 for(const currency of ['SSP','KES'])opened.set(currency,await cash.open(conn,tenant,owner,{currency,openingCash:'500.00'}));
 const indexes=await core.cashSessionModel(conn).collection.indexes();assert(indexes.some(index=>index.unique&&index.key.branchId===1&&index.key.operatorId===1&&index.key.currency===1&&index.partialFilterExpression.activeKey));
 assert.equal(await core.cashSessionModel(conn).countDocuments({branchId:branch._id,status:'pending_open'}),4);
 for(const [currency,shift] of opened){
  await cash.decideOpening(conn,tenant,reviewer,shift._id,{decision:'approve',note:'Independent physical count checked for this currency drawer'});
  const amount=currency==='UGX'?'12':'12.34';
  const record=await mobile.recordMobileMoney(conn,owner,{customer:'Multicurrency customer',customerPhone:'+256700123456',network:currency==='SSP'?'MTN SSD':'MTN',currency,amount,fee:'0',networkReference:`MULTI-${nonce}-${currency}`,idempotencyKey:crypto.randomUUID()},'cash_in',tenant);
  assert.equal(String(record.created.cashSessionId),String(shift._id));assert.equal(record.created.currency,currency);assert.equal(String(record.created.amountMinor),currency==='UGX'?'12':'1234');
  await mobile.reviewMobileMoney(conn,reviewer,record.created._id,'accepted','Independent provider receipt and currency evidence inspected');
  for(const other of [...opened.keys()].filter(code=>code!==currency)){
   const unchanged=await core.cashSessionModel(conn).findById(opened.get(other)._id).lean();
   if(unchanged.recordCount===0)assert.equal(String(unchanged.provisionalMovementMinor),'0','another currency cash drawer must remain unchanged');
  }
  const reference=await banking.createReference(conn,tenant,owner,{customerName:'Multicurrency customer',institutionName:'Recorded bank',last4:'1234',currency});assert.equal(reference.currency,currency);
  const instruction=await transfer.createRequest(conn,tenant,owner,{destinationBranchId:String(destinationBranch._id),senderName:'Typed sender',senderPhone:'+256700111222',senderCountry:'UG',receiverName:'Typed receiver',receiverPhone:'+256700123456',receiverCountry:'UG',currency,amount,fee:'0',idempotencyKey:crypto.randomUUID()});assert.equal(instruction.order.currency,currency);
  for(const [suffix,category] of [['CASH','asset'],['CONTROL','liability']])await ledger.createAccount(conn,{branchId:owner.branchId,actorId:owner.id,code:`MULTI_${currency}_${suffix}`,name:`${currency} recorded ${suffix}`,category,currency});
  const journal=await ledger.postJournal(conn,{branchId:owner.branchId,actorId:owner.id,currency,sourceType:'banking',sourceRef:`multicurrency:${nonce}:${currency}`,lines:[{accountCode:`MULTI_${currency}_CASH`,side:'debit',amountMinor:'1234'},{accountCode:`MULTI_${currency}_CONTROL`,side:'credit',amountMinor:'1234'}]});assert((await ledger.inspectJournal(conn,journal.journal._id)).valid);
  assert((await ledger.trialBalance(conn,{branchId:owner.branchId,currency})).balanced);
  const closed=await cash.submit(conn,tenant,owner,shift._id,{countedCash:currency==='UGX'?'512':'512.34',note:'Independent closing count uses only the selected currency drawer'});assert.equal(String(closed.varianceMinor),'0');await cash.decide(conn,tenant,reviewer,shift._id,{decision:'approve',note:'Each currency closing matches its own immutable records'});
 }
 assert.equal((await core.branchModel(conn).findById(branch._id)).currency,'UGX');
 const rate=await forex.proposeRate(conn,tenant,owner,{fromCurrency:'USD',toCurrency:'SSP',rateDecimal:'2.5',validHours:2,note:'Indicative multi-currency exchange board independently checked'});await forex.decideRate(conn,tenant,reviewer,rate._id,{decision:'approve',note:'Independent USD to SSP rate source evidence inspected'});
 const quote=await forex.createQuote(conn,tenant,owner,{rateId:String(rate._id),operation:'buy',customerLabel:'Multicurrency customer',amount:'12.34',note:'Customer agreed to the explicit USD to SSP indicative quote',validMinutes:15,idempotencyKey:crypto.randomUUID()});assert.equal(String(quote.quote.targetMinor),'3085');
 // A selected subset remains authoritative; enabling more requires an owner change.
 const limited=await branches.create(tenant,owner,{name:'Selected subset',code:'subset',currency:'UGX',currencies:['UGX','USD']});
 await branches.setOperatingBranch(tenant,owner,String(limited._id));owner.branchId=String(limited._id);
 await assert.rejects(cash.open(conn,tenant,owner,{currency:'SSP',openingCash:'0'}),{status:409});
 await branches.update(tenant,owner,String(limited._id),{name:limited.name,address:'',currencies:['UGX','USD','SSP']});
 const enabled=await cash.open(conn,tenant,owner,{currency:'SSP',openingCash:'0'});assert.equal(enabled.currency,'SSP');
 await assert.rejects(branches.update(tenant,owner,String(limited._id),{name:limited.name,address:'',currencies:['UGX','USD']}),{status:409},'cannot disable an unfinished currency drawer');
 await assert.rejects(branches.update(tenant,owner,String(limited._id),{name:limited.name,address:'',currencies:['USD','SSP']}),{status:409},'default remains enabled');
 console.log('PASS: one branch runs UGX/USD/SSP/KES with independent drawers, legacy and mixed-key uniqueness, concurrent opening fence, exact isolated MoMo records, bank/transfer instructions, balanced per-currency journals, FX pair, owner currency selection and guarded disabling.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_branch_ccy_[a-f0-9]{16}$/.test(platformName)){if(conn?.name===require('../src/config/tenantDatabaseName').tenantDbNameFromSlug(slug))await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('BRANCH MULTICURRENCY INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Branch currency cleanup failed:',error.message);process.exitCode=1;}));
