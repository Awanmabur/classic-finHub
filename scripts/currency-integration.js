#!/usr/bin/env node
'use strict';
// Application-service checks in random, self-owned loopback scratch databases.
// Ledger fixtures prove accounting invariants, not an external funds settlement.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)
 throw Error('Currency integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),platformName=`cfh_currency_probe_${nonce}`,slugs=[`probe-currency-a-${nonce}`,`probe-currency-b-${nonce}`];
configured.pathname='/'+platformName;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const models=require('../src/tenant/models');
const Tenant=require('../src/platform/models/Tenant'),commerce=require('../src/platform/services/commercial.service');
const mobile=require('../src/tenant/services/mobileMoney.service'),mobileWorkspace=require('../src/tenant/services/mobileMoneyWorkspace.service');
const cash=require('../src/tenant/services/cashDrawer.service'),branches=require('../src/tenant/services/branch.service');
const ledger=require('../src/tenant/services/ledger.service'),banking=require('../src/tenant/services/banking.service'),transfer=require('../src/tenant/services/moneyTransfer.service'),forex=require('../src/tenant/services/forex.service');
const operations=require('../src/tenant/services/operationWorkspace.service'),{permissionsFor}=require('../src/config/roles');
let connections=[];
async function main(){
 await connectPlatformMongo();
 require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),require('../src/platform/models/UsageCounter').createIndexes()]);
 connections=slugs.map(getTenantConnection);await Promise.all(connections.map(models.ensureTenantIndexes));
 const [conn,other]=connections;
 const owner={id:String(new mongoose.Types.ObjectId()),role:'Tenant Owner',permissions:['*']};
 const reviewer={id:String(new mongoose.Types.ObjectId()),role:'Reconciliation Officer',permissions:permissionsFor('Reconciliation Officer'),allowedModules:['mobile_money','money_transfer','banking','forex']};
 await models.tenantUserModel(conn).create([
  {_id:owner.id,name:'Currency owner',email:'currency-owner@example.invalid',passwordHash:'scratch-not-a-real-password',role:owner.role,status:'active',mfaEnabledAt:new Date()},
  {_id:reviewer.id,name:'Currency reviewer',email:'currency-reviewer@example.invalid',passwordHash:'scratch-not-a-real-password',role:reviewer.role,status:'active',allowedModules:reviewer.allowedModules,mfaEnabledAt:new Date()}
 ]);
 const snapshot=commerce.planSnapshot({...commerce.asPlanVersion(require('../src/data/store').plans.find(plan=>plan.code==='enterprise')),status:'published'});
 const tenant=await Tenant.create({name:'Currency integration',slug:slugs[0],dbName:conn.name,owner:'Scratch owner',email:`${nonce}@example.invalid`,plan:'enterprise',status:'active',setupStatus:'complete',enabledModules:snapshot.modules,seatsReserved:2,branchCount:0,
  subscription:{...snapshot,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const createdBranches=[];
 for(const currency of ['USD','SSP']){
  const branch=await branches.create(tenant,owner,{name:`${currency} branch`,code:currency.toLowerCase()+'-branch',currency});createdBranches.push(branch);
  await branches.setOperatingBranch(tenant,owner,String(branch._id));
  owner.branchId=String(branch._id);reviewer.branchId=owner.branchId;
  await models.tenantUserModel(conn).updateOne({_id:reviewer.id},{$set:{branchId:reviewer.branchId}});
  const opened=await cash.open(conn,tenant,owner,{openingCash:'500.00'});
  await cash.decideOpening(conn,tenant,reviewer,String(opened._id),{decision:'approve',note:'Independent opening cash count checked for currency test'});
  const records=[];
  for(const [operation,amount] of [['cash_in','123.45'],['cash_out','23.45']]){
   const input={customer:'Currency customer',customerPhone:'+256700123456',network:'MTN',currency,amount,fee:'0.01',networkReference:`CCY-${nonce}-${currency}-${operation}`,idempotencyKey:crypto.randomUUID()};
   const result=await mobile.recordMobileMoney(conn,owner,input,operation,tenant);records.push(result.created);
   assert.equal(String(result.created.amountMinor),operation==='cash_in'?'12345':'2345');
   assert.equal(String(result.created.feeMinor),'1');assert.equal(result.created.currency,currency);
   assert.equal((await mobile.recordMobileMoney(conn,owner,input,operation,tenant)).duplicate,true);
   await mobile.reviewMobileMoney(conn,reviewer,String(result.created._id),'accepted','Independent receipt evidence checked for currency test');
  }
  const incompatible={customer:'Currency mismatch',network:'MTN',currency:currency==='USD'?'SSP':'USD',amount:'1.00',fee:'0',networkReference:`CCY-WRONG-${nonce}-${currency}`,idempotencyKey:crypto.randomUUID()};
  await assert.rejects(mobile.recordMobileMoney(conn,owner,incompatible,'cash_in',tenant),{status:409});
  const day=new Date().toISOString().slice(0,10);
  const summary=await mobileWorkspace.workspace(conn,owner,{from:day,to:day,currency});
  assert.equal(summary.summary.total,2);assert.equal(summary.summary.byCurrency.length,1);
  assert.equal(summary.summary.byCurrency[0].volumeMinor,'14690');assert.equal(summary.summary.byCurrency[0].cashImpactMinor,'10000');
  const closed=await cash.submit(conn,tenant,owner,String(opened._id),{countedCash:'600.00',note:'Physical cash count agrees with immutable source records'});
  assert.equal(String(closed.expectedClosingMinor),'60000');assert.equal(String(closed.varianceMinor),'0');
  await cash.decide(conn,tenant,reviewer,String(opened._id),{decision:'approve',note:'Independent closing reconciliation agrees exactly'});
  for(const [code,name,category] of [['CASH_CCY',`${currency} cash on hand`,'asset'],['CONTROL_CCY',`${currency} accounting control`,'liability']])
   await ledger.createAccount(conn,{branchId:owner.branchId,actorId:owner.id,code,name,category,currency});
  const journal={branchId:owner.branchId,actorId:owner.id,currency,sourceType:'banking',sourceRef:`scratch:currency:${nonce}:${currency}`,lines:[{accountCode:'CASH_CCY',side:'debit',amountMinor:'12345'},{accountCode:'CONTROL_CCY',side:'credit',amountMinor:'12345'}]};
  const posting=await ledger.postJournal(conn,journal);assert.equal(posting.duplicate,false);
  assert.equal((await ledger.postJournal(conn,journal)).duplicate,true);
  assert.equal((await ledger.inspectJournal(conn,String(posting.journal._id))).valid,true);
  const trial=await ledger.trialBalance(conn,{branchId:owner.branchId,currency});
  assert.equal(trial.totalDebitsMinor,'12345');assert.equal(trial.totalCreditsMinor,'12345');
  await assert.rejects(ledger.postJournal(conn,{...journal,sourceRef:`scratch:wrong:${nonce}:${currency}`,currency:currency==='USD'?'SSP':'USD'}),{status:409});
  await assert.rejects(ledger.postJournal(other,journal),{status:403});
  const reference=await banking.createReference(conn,tenant,owner,{customerName:'Currency customer',institutionName:'Currency test bank',last4:'1234',currency});
  const request=await banking.createRequest(conn,tenant,owner,{sourceId:String(reference._id),kind:'deposit_request',currency,amount:'12.34',note:'Customer banking instructions for exact currency testing',idempotencyKey:crypto.randomUUID()});
  assert.equal(String(request.order.amountMinor),'1234');
  const contacts=[];
  for(const [kind,phone] of [['sender','+256700123456'],['beneficiary','+256700123457']])contacts.push(await transfer.addContact(conn,tenant,owner,{kind,phone,country:'UG',fullName:`Currency ${kind}`}));
  const order=await transfer.createRequest(conn,tenant,owner,{senderId:String(contacts[0]._id),beneficiaryId:String(contacts[1]._id),currency,amount:'12.34',fee:'0.01',idempotencyKey:crypto.randomUUID()});
  assert.equal(String(order.order.amountMinor),'1234');assert.equal(String(order.order.feeMinor),'1');
  const rate=await forex.proposeRate(conn,tenant,owner,{fromCurrency:currency,toCurrency:currency==='USD'?'SSP':'USD',rateDecimal:'2.5',validHours:2,note:'Internal indicative rate for exact currency test'});
  await forex.decideRate(conn,tenant,reviewer,String(rate._id),{decision:'approve',note:'Independent indicative rate source checked for test'});
  const quote=await forex.createQuote(conn,tenant,owner,{rateId:String(rate._id),customerLabel:'Currency customer',amount:'12.34',operation:'buy',note:'Internal unexecuted quote for exact currency test',validMinutes:15,idempotencyKey:crypto.randomUUID()});
  assert.equal(String(quote.quote.sourceMinor),'1234');assert.equal(String(quote.quote.targetMinor),'3085');
  for(const key of ['money_transfer','banking','forex']){
   const report=await operations.report(conn,tenant,owner,key,{from:day,to:day,currency});
   assert.equal(report.total,1);assert.equal(report.rows[0].currency,currency);
   assert.match(operations.csv(report),new RegExp(currency));
  }
 }
 assert.equal((await models.branchModel(conn).find({currency:{$in:['USD','SSP']}})).length,2);
 assert.equal(await models.mobileTransactionModel(other).countDocuments(),0);
 assert.equal(await models.ledgerJournalModel(other).countDocuments(),0);
 console.log('PASS: USD/SSP real branch creation, exact cash-in/out, immutable replay, currency mismatch rollback, verified drawer closing, balanced ledger, bank/transfer instructions, FX quotes, scoped currency filters and tenant isolation.');
}
async function cleanup(){
 if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_currency_probe_[a-f0-9]{16}$/.test(platformName)){
  for(const conn of connections)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();
 }await mongoose.disconnect();
}
main().catch(error=>{console.error('CURRENCY INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Currency scratch cleanup failed:',error.message);process.exitCode=1;}));
