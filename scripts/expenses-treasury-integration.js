#!/usr/bin/env node
'use strict';
// Every balance and identity below belongs to a disposable loopback database.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
require('dotenv').config();
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Expense funds verification requires an unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),scratch=`cfh_expense_funds_${nonce}`,slug=`expense-funds-${nonce}`;
configured.pathname='/'+scratch;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose'),Tenant=require('../src/platform/models/Tenant');
const core=require('../src/tenant/models'),expenses=require('../src/tenant/services/expenses.service'),cash=require('../src/tenant/services/cashDrawer.service');
const treasury=require('../src/tenant/treasury/service'),{models,ensure}=require('../src/tenant/treasury/models');
const {expenseModel}=require('../src/tenant/models/expenses'),{permissionsFor}=require('../src/config/roles');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo'),commerce=require('../src/platform/services/commercial.service');
let conn,tenant;
const note='Independent physical or statement evidence reviewed against the original voucher';
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 conn=getTenantConnection(slug);await Promise.all([core.ensureTenantIndexes(conn),ensure(conn),Tenant.createIndexes()]);
 const modules=['mobile_money','expenses'],terms={code:'expense_funds',name:'Expense funds test',description:'Disposable verified expense funds test',currency:'USD',priceMonthly:1,priceYearly:10,trialMonths:0,modules,
  limits:{users:10,branches:3,transactionsPerMonth:1000,smsPerMonth:0,storageMb:1000}};
 const snapshot=commerce.planSnapshot({...commerce.asPlanVersion(terms),status:'published'});
 tenant=await Tenant.create({name:'Expense funds test',slug,dbName:conn.name,owner:'Owner',email:`${nonce}@example.invalid`,plan:terms.code,status:'active',setupStatus:'complete',enabledModules:modules,
  seatsReserved:4,branchCount:1,subscription:{...snapshot,generation:1,status:'granted',source:'manual_admin_grant',periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const branch=await core.branchModel(conn).create({name:'Verified expense branch',code:'verified-expense',currency:'KES',createdBy:new mongoose.Types.ObjectId(),updatedBy:new mongoose.Types.ObjectId()});
 const person=async(role)=>{
  const row=await core.tenantUserModel(conn).create({name:role,email:`${crypto.randomBytes(8).toString('hex')}@example.invalid`,passwordHash:'Scratch-only-unused-login',role,branchId:String(branch._id),allowedModules:modules,status:'active',mfaEnabledAt:new Date()});
  return {id:String(row._id),name:role,role,branchId:String(branch._id),allowedModules:modules,authVersion:0,permissions:permissionsFor(role)};
 };
 const owner=await person('Tenant Owner'),maker=await person('Mobile Money Operator'),reviewer=await person('Reconciliation Officer'),other=await person('Mobile Money Operator');
 const shift=await cash.open(conn,tenant,maker,{openingCash:'1000.00'});await cash.decideOpening(conn,tenant,reviewer,shift._id,{decision:'approve',note});
 const unconfigured=(await expenses.create(conn,tenant,maker,{expenseType:'Unconfigured bank expense',currency:'KES',amount:'5.00',paymentMethod:'Bank',reference:'PENDING-SOURCE',
  idempotencyKey:crypto.randomUUID(),sourcePolicy:'legacy_untracked',requireFunds:false},{requireFunds:true})).record;
 assert.equal(unconfigured.sourcePolicy,'funded_required','request fields cannot disable the HTTP funds requirement');
 await assert.rejects(expenses.review(conn,tenant,reviewer,unconfigured._id,{decision:'approve',note}),{status:409});
 assert.equal((await expenseModel(conn).findById(unconfigured._id)).status,'pending_review');
 await expenses.review(conn,tenant,reviewer,unconfigured._id,{decision:'reject',note});
 const readShift=async()=>core.cashSessionModel(conn).findById(shift._id).lean();
 async function openFund(kind,name,amount,network=''){
  const account=await treasury.createAccount(conn,tenant,owner,{code:name.toUpperCase(),name:`Verified ${name}`,kind,currency:'KES',network,operatorId:kind==='cash'||kind==='wallet'?maker.id:'',isDefault:true});
  const observation=await treasury.requestObservation(conn,tenant,maker,account._id,{kind:'opening',actualBalance:amount,observedAt:new Date(Date.now()-5000).toISOString(),
   evidenceType:kind==='cash'?'cash_count':kind==='bank'?'bank_statement':'provider_app',evidenceReference:`OPEN-${name}-${nonce}`,note,idempotencyKey:crypto.randomUUID()});
  await treasury.reviewObservation(conn,tenant,reviewer,observation.observation._id,{decision:'approve',note});return account;
 }
 const cashFund=await openFund('cash','cash_fund','1000.00'),bankFund=await openFund('bank','bank_fund','500.00'),walletFund=await openFund('wallet','wallet_fund','200.00','MTN');
 const balance=async account=>String((await models(conn).account.findById(account._id)).bookBalanceMinor);
 const body=(extra={})=>({expenseType:'Office transport',currency:'KES',amount:'100.00',paymentMethod:'Cash',vendor:'Reviewed vendor',reference:`VOUCHER-${nonce}`,description:'Actual operating expense with source evidence',idempotencyKey:crypto.randomUUID(),...extra});
 const cashInput=body({treasuryAccountId:String(cashFund._id)}),record=(await expenses.create(conn,tenant,maker,cashInput,{requireFunds:true})).record;
 assert.equal(record.sourcePolicy,'funded_required');assert.equal(await balance(cashFund),'100000');assert.equal(String((await readShift()).provisionalMovementMinor),'0');
 assert.equal((await expenses.create(conn,tenant,maker,cashInput,{requireFunds:true})).duplicate,true);
 await assert.rejects(expenses.create(conn,tenant,maker,{...cashInput,treasuryAccountId:String(bankFund._id)},{requireFunds:true}),{status:409});
 await assert.rejects(expenses.create(conn,tenant,other,body({treasuryAccountId:String(cashFund._id)}),{requireFunds:true}),{status:403});
 const reviews=await Promise.allSettled([reviewer,owner].map(actor=>expenses.review(conn,tenant,actor,record._id,{decision:'approve',note})));
 assert.equal(reviews.filter(row=>row.status==='fulfilled').length,1);assert.equal(reviews.filter(row=>row.status==='rejected'&&row.reason.status===409).length,1);
 let posted=await expenseModel(conn).findById(record._id).lean();assert(posted.treasuryBatchId);assert.equal(String(posted.postedTreasuryAccountId),String(cashFund._id));
 assert.equal(await balance(cashFund),'90000');assert.equal(String((await readShift()).provisionalMovementMinor),'-10000','the drawer is reduced exactly once');
 const batch=await models(conn).batch.findById(posted.treasuryBatchId).lean(),lines=await core.ledgerPostingModel(conn).find({journalId:{$in:batch.journalIds}}).lean();
 assert.equal(lines.length,2);assert.equal(lines.reduce((sum,line)=>sum+BigInt(String(line.amountMinor))*(line.side==='debit'?1n:-1n),0n),0n);
 await expenses.requestChange(conn,tenant,maker,record._id,{...cashInput,amount:'120.00',note:'Original receipt confirms the corrected operating expense amount'});
 posted=await expenses.decideChange(conn,tenant,reviewer,record._id,{decision:'approve',note});
 assert.equal(String(posted.amountMinor),'12000');assert.equal(String(posted.original.amountMinor),'10000');assert.equal(await balance(cashFund),'88000');assert.equal(String((await readShift()).provisionalMovementMinor),'-12000');
 assert(posted.lastReversalBatchId);assert.equal(await models(conn).batch.countDocuments({sourceType:'expenses'}),3);
 await expenses.requestChange(conn,tenant,reviewer,record._id,{note:'Independent voucher inspection shows this expense should be voided'},'void');
 await assert.rejects(expenses.decideChange(conn,tenant,reviewer,record._id,{decision:'approve',note}),{status:403});
 posted=await expenses.decideChange(conn,tenant,owner,record._id,{decision:'approve',note});assert.equal(posted.status,'voided');assert.equal(await balance(cashFund),'100000');assert.equal(String((await readShift()).provisionalMovementMinor),'0');
 const tooLarge=(await expenses.create(conn,tenant,maker,body({amount:'2000.00',treasuryAccountId:String(cashFund._id)}),{requireFunds:true})).record;
 const batchesBefore=await models(conn).batch.countDocuments({});await assert.rejects(expenses.review(conn,tenant,reviewer,tooLarge._id,{decision:'approve',note}),{status:409});
 assert.equal((await expenseModel(conn).findById(tooLarge._id)).status,'pending_review');assert.equal(await balance(cashFund),'100000');assert.equal(await models(conn).batch.countDocuments({}),batchesBefore);
 await expenses.review(conn,tenant,reviewer,tooLarge._id,{decision:'reject',note});
 const bank=(await expenses.create(conn,tenant,maker,body({paymentMethod:'Bank',amount:'25.45',treasuryAccountId:String(bankFund._id)}),{requireFunds:true})).record;
 await expenses.review(conn,tenant,reviewer,bank._id,{decision:'approve',note});assert.equal(await balance(bankFund),'47455');assert.equal(String((await readShift()).provisionalMovementMinor),'0');
 const wallet=(await expenses.create(conn,tenant,maker,body({paymentMethod:'Mobile Money',amount:'50.00',treasuryAccountId:String(walletFund._id)}),{requireFunds:true})).record;
 await expenses.review(conn,tenant,reviewer,wallet._id,{decision:'approve',note});assert.equal(await balance(walletFund),'15000');assert.equal(String((await readShift()).provisionalMovementMinor),'0');
 const revoked=(await expenses.create(conn,tenant,maker,body({paymentMethod:'Mobile Money',amount:'10.00',treasuryAccountId:String(walletFund._id)}),{requireFunds:true})).record;
 const beforeRevoked=await models(conn).batch.countDocuments({});
 await core.tenantUserModel(conn).updateOne({_id:maker.id},{$set:{allowedModules:['expenses']},$inc:{authVersion:1}});
 await assert.rejects(expenses.review(conn,tenant,reviewer,revoked._id,{decision:'approve',note}),{status:403});
 assert.equal((await expenseModel(conn).findById(revoked._id)).status,'pending_review');assert.equal(await balance(walletFund),'15000');assert.equal(await models(conn).batch.countDocuments({}),beforeRevoked,'a reviewer cannot bypass the originating maker underlying funds-module revocation');
 await core.tenantUserModel(conn).updateOne({_id:maker.id},{$set:{allowedModules:modules},$inc:{authVersion:1}});maker.authVersion=2;
 await expenses.review(conn,tenant,reviewer,revoked._id,{decision:'reject',note});
 const checkpoint=await treasury.requestObservation(conn,tenant,maker,walletFund._id,{kind:'checkpoint',actualBalance:'100.00',observedAt:new Date().toISOString(),evidenceType:'provider_app',
  evidenceReference:`PROVIDER-CHECK-${nonce}`,note,idempotencyKey:crypto.randomUUID()});await treasury.reviewObservation(conn,tenant,owner,checkpoint.observation._id,{decision:'approve',note});
 const held=(await expenses.create(conn,tenant,maker,body({paymentMethod:'Mobile Money',amount:'10.00',treasuryAccountId:String(walletFund._id)}),{requireFunds:true})).record;
 await assert.rejects(expenses.review(conn,tenant,reviewer,held._id,{decision:'approve',note}),{status:409});assert.equal(await balance(walletFund),'15000');
 assert.equal((await models(conn).account.findById(walletFund._id)).status,'held');assert.equal((await expenseModel(conn).findById(held._id)).status,'pending_review');
 const sourceChoices=await expenses.fundChoices(conn,tenant,maker);assert(sourceChoices.some(row=>row._id===String(cashFund._id)));assert(!sourceChoices.some(row=>row._id===String(walletFund._id)));
 const wrongConn=getTenantConnection(`foreign-expense-${nonce}`);await assert.rejects(expenses.review(wrongConn,tenant,reviewer,bank._id,{decision:'approve',note}),{status:403});
 await assert.rejects(models(conn).batch.updateOne({_id:batch._id},{$set:{description:'tampered'}}),/append-only/);
 console.log('PASS: independently approved expenses post balanced funds-book journals once, Cash updates its physical drawer once, Bank/wallet expense sources remain separate, corrections and voids append reversals, and mismatches/insufficient or foreign sources cannot spend.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===scratch&&/^cfh_expense_funds_[a-f0-9]{16}$/.test(scratch)){if(conn)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('Expense treasury integration FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error(error.message);process.exitCode=1;}));
