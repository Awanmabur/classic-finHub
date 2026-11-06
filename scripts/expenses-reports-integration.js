#!/usr/bin/env node
'use strict';
// Destructive cleanup is limited to random scratch databases on loopback.
require('dotenv').config();
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Expenses integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex');
const scratchName=`cfh_expense_probe_${nonce}`,slugs=[`probe-expense-a-${nonce}`,`probe-expense-b-${nonce}`];
configured.pathname='/'+scratchName;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {tenantDbNameFromSlug}=require('../src/config/tenantDatabaseName');
const models=require('../src/tenant/models');
const {expenseModel}=require('../src/tenant/models/expenses');
const expenses=require('../src/tenant/services/expenses.service');
const reports=require('../src/tenant/services/approvedReports.service');
const cash=require('../src/tenant/services/cashDrawer.service');
const mobile=require('../src/tenant/services/mobileMoney.service');
const Tenant=require('../src/platform/models/Tenant');
const Usage=require('../src/platform/models/UsageCounter');
const commercial=require('../src/platform/services/commercial.service');
const {permissionsFor}=require('../src/config/roles');
const id=()=>String(new mongoose.Types.ObjectId());
let connections=[];
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 connections=slugs.map(getTenantConnection);await Promise.all([Tenant.createIndexes(),Usage.createIndexes(),...connections.map(models.ensureTenantIndexes)]);
 const [conn,other]=connections;
 const terms={code:'expense_probe',name:'Expense probe plan',priceMonthly:1,priceYearly:10,currency:'USD',trialMonths:0,modules:['mobile_money','expenses','reports'],
  limits:{users:10,branches:5,transactionsPerMonth:100,smsPerMonth:0,storageMb:500},description:'Scratch expense integration'};
 const snapshot=commercial.planSnapshot({...commercial.asPlanVersion(terms),status:'published'});
 const tenant=await Tenant.create({name:'Expense integration',slug:slugs[0],dbName:conn.name,owner:'Probe',email:`${nonce}@example.invalid`,plan:terms.code,status:'active',setupStatus:'complete',enabledModules:terms.modules,seatsReserved:4,branchCount:3,
  subscription:{...snapshot,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const tenantB=await Tenant.create({name:'Other expense integration',slug:slugs[1],dbName:other.name,owner:'Other',email:`b-${nonce}@example.invalid`,plan:terms.code,status:'active',setupStatus:'complete',enabledModules:terms.modules,seatsReserved:1,branchCount:0,
  subscription:{...snapshot,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const user=async(role,branchId,allowedModules=terms.modules)=>{
  const row=await models.tenantUserModel(conn).create({name:role,email:`${id()}@example.invalid`,passwordHash:'Not a real login hash',role,branchId:branchId||null,allowedModules,status:'active'});
  return {id:String(row._id),role,branchId:branchId||null,allowedModules,permissions:permissionsFor(role),authVersion:0};
 };
 const operator=await user('Mobile Money Operator'),reviewer=await user('Reconciliation Officer'),owner=await user('Tenant Owner'),third=await user('Reconciliation Officer');
 const branch=await models.branchModel(conn).create({name:'KES drawer',code:'kes-drawer',currency:'KES',createdBy:owner.id,updatedBy:owner.id});
 const usd=await models.branchModel(conn).create({name:'USD drawer',code:'usd-drawer',currency:'USD',createdBy:owner.id,updatedBy:owner.id});
 for(const person of [operator,reviewer,owner,third]){person.branchId=String(branch._id);await models.tenantUserModel(conn).updateOne({_id:person.id},{$set:{branchId:person.branchId}});}
 const shift=await cash.open(conn,tenant,operator,{openingCash:'1000.00'});
 await cash.decideOpening(conn,tenant,reviewer,String(shift._id),{decision:'approve',note:'Independent opening physical cash count verified'});
 const balance=async()=>String((await models.cashSessionModel(conn).findById(shift._id)).provisionalMovementMinor);
 const input=(extra={})=>({idempotencyKey:crypto.randomUUID(),expenseType:'Transport',currency:'KES',amount:'100.00',paymentMethod:'Cash',vendor:'=Untrusted vendor',reference:'+Receipt',description:'Business transport with receipt',...extra});
 const firstInput=input(),first=(await expenses.create(conn,tenant,operator,firstInput)).record;
 assert.equal(first.status,'pending_review');assert.equal(await balance(),'0');assert.equal(String(first.amountMinor),'10000');
 assert.equal((await expenses.create(conn,tenant,operator,firstInput)).duplicate,true);
 await assert.rejects(expenses.create(conn,tenant,operator,{...firstInput,amount:'101.00'}),{status:409});
 assert.equal(await expenseModel(conn).countDocuments({}),1);assert.equal((await Usage.findOne({tenantId:tenant._id,metric:'expenses'})).quantity,1);
 await assert.rejects(expenses.review(conn,tenant,{...operator,role:'Tenant Owner',permissions:['*']},first._id,{decision:'approve',note:'Forged role cannot self authorize this expense'}),{status:403});
 await assert.rejects(expenses.review(other,tenant,reviewer,first._id,{decision:'approve',note:'Wrong database must not read this expense'}),{status:403});
 await assert.rejects(expenses.detail(other,tenantB,reviewer,first._id),{status:403});
 await assert.rejects(cash.submit(conn,tenant,operator,String(shift._id),{countedCash:'1000.00'}),{status:409});
 const approved=await expenses.review(conn,tenant,reviewer,first._id,{decision:'approve',note:'Vendor receipt and cash payment checked independently'});
 assert.equal(approved.status,'approved');assert.equal(await balance(),'-10000');
 const reviews=await Promise.allSettled([expenses.review(conn,tenant,reviewer,first._id,{decision:'approve',note:'Must not approve twice or deduct cash twice'}),expenses.review(conn,tenant,third,first._id,{decision:'approve',note:'Concurrent retry must never deduct twice'})]);
 assert(reviews.every(result=>result.status==='rejected'));assert.equal(await balance(),'-10000');
 const noncash=(await expenses.create(conn,tenant,operator,input({paymentMethod:'Bank',amount:'25.45'}))).record;
 await expenses.review(conn,tenant,reviewer,noncash._id,{decision:'approve',note:'Bank evidence reviewed without executing payment'});
 assert.equal(noncash.cashSessionId,null);assert.equal(await balance(),'-10000');
 const rejected=(await expenses.create(conn,tenant,operator,input({amount:'20.00'}))).record;
 await expenses.review(conn,tenant,reviewer,rejected._id,{decision:'reject',note:'Receipt does not support this requested expense'});
 assert.equal(await balance(),'-10000');
 await expenses.requestChange(conn,tenant,operator,first._id,{...firstInput,amount:'120.00',note:'Receipt confirms a larger amount than originally entered'});
 assert.equal(await balance(),'-10000');
 await assert.rejects(expenses.decideChange(conn,tenant,{...operator,role:'Tenant Owner',permissions:['*']},first._id,{decision:'approve',note:'The originator cannot approve their own correction'}),{status:403});
 const corrected=await expenses.decideChange(conn,tenant,reviewer,first._id,{decision:'approve',note:'Independent receipt check confirms corrected amount'});
 assert.equal(String(corrected.amountMinor),'12000');assert.equal(String(corrected.original.amountMinor),'10000');assert.equal(await balance(),'-12000');
 await expenses.requestChange(conn,tenant,reviewer,first._id,{note:'An independent request to void the duplicate expense'},'void');
 await assert.rejects(expenses.decideChange(conn,tenant,reviewer,first._id,{decision:'approve',note:'A requester cannot approve their own void'}),{status:403});
 await expenses.decideChange(conn,tenant,third,first._id,{decision:'approve',note:'A third independent reviewer verified the void request'});
 assert.equal(await balance(),'0');assert.equal((await expenseModel(conn).findById(first._id)).status,'voided');
 assert.equal((await expenseModel(conn).findById(first._id)).history.length,6);
 const cashExpense=(await expenses.create(conn,tenant,operator,input({amount:'15.50'}))).record;
 await expenses.review(conn,tenant,reviewer,cashExpense._id,{decision:'approve',note:'Physical receipt and paid amount independently checked'});
 const concurrent=(await expenses.create(conn,tenant,operator,input({amount:'5.00'}))).record;
 const decisions=await Promise.allSettled([reviewer,third].map(person=>expenses.review(conn,tenant,person,concurrent._id,{decision:'approve',note:'Concurrent independent approval must post only once'})));
 assert.equal(decisions.filter(result=>result.status==='fulfilled').length,1);
 assert.equal(decisions.filter(result=>result.status==='rejected'&&result.reason.status===409).length,1);
 assert.equal(await balance(),'-2050');
 assert.equal(await models.auditEventModel(conn).countDocuments({targetId:concurrent._id,action:'expenses.approved'}),1);
 const insufficient=(await expenses.create(conn,tenant,operator,input({amount:'2000.00'}))).record;
 await assert.rejects(expenses.review(conn,tenant,reviewer,insufficient._id,{decision:'approve',note:'Insufficient physical cash must roll back the posting'}),{status:409});
 assert.equal((await expenseModel(conn).findById(insufficient._id)).status,'pending_review');assert.equal(await balance(),'-2050');
 assert.equal(await models.auditEventModel(conn).countDocuments({targetId:insufficient._id,action:'expenses.approved'}),0);
 await expenses.review(conn,tenant,reviewer,insufficient._id,{decision:'reject',note:'Requested amount exceeds the available physical drawer'});
 const mobileInput={idempotencyKey:crypto.randomUUID(),customer:'Cash customer',network:'MTN',networkReference:`EXP-MOBILE-${nonce}`,currency:'KES',amount:'40.00',fee:'1.25'};
 const mobileRecord=(await mobile.recordMobileMoney(conn,operator,mobileInput,'cash_in',tenant)).created;
 await mobile.reviewMobileMoney(conn,reviewer,String(mobileRecord._id),'accepted','Receipt checked independently for closing cash');
 const wallet=(await mobile.recordMobileMoney(conn,operator,{...mobileInput,idempotencyKey:crypto.randomUUID(),networkReference:`EXP-WALLET-${nonce}`,amount:'50.00',paymentMethod:'Wallet Balance'},'cash_in',tenant)).created;
 await mobile.reviewMobileMoney(conn,reviewer,String(wallet._id),'accepted','Wallet evidence does not change physical cash');
 assert.equal(await balance(),'1950');
 const submitted=await cash.submit(conn,tenant,operator,String(shift._id),{countedCash:'1019.50'});
 assert.equal(String(submitted.expectedClosingMinor),'101950');assert.equal(String(submitted.varianceMinor),'0');
 await assert.rejects(expenses.requestChange(conn,tenant,operator,cashExpense._id,{...firstInput,amount:'16.00',note:'A submitted drawer must be disputed before correction'}),{status:409});
 const today=new Date().toISOString().slice(0,10);
 const daily=await reports.generate(conn,tenant,owner,'daily',{from:today,to:today});
 assert.equal(daily.cash.totals.find(row=>row.currency==='KES').expectedMinor,'101950');
 assert.equal(daily.income.find(row=>row.currency==='KES').approvedExpensesMinor,'4595');
 const expenseReport=await reports.generate(conn,tenant,owner,'expenses',{from:today,to:today});assert.equal(expenseReport.expenses.length,6);
 assert.match(reports.csv(expenseReport),/'=Untrusted vendor/);assert.match(reports.csv(expenseReport),/'\+Receipt/);
 for(const page of Object.keys(reports.pages)){const result=await reports.generate(conn,tenant,owner,page,{from:today,to:today});assert.equal(result.page,reports.pages[page]);}
 const noExpenses={...tenant.toObject(),enabledModules:['reports'],subscription:{...tenant.subscription.toObject(),modules:['reports']}};
 const unavailable=await reports.generate(conn,noExpenses,owner,'expenses',{from:today,to:today});assert.equal(unavailable.sourceAvailable,false);assert.equal(unavailable.expenses,null);assert.equal(unavailable.rows.length,0);
 const noReport={...tenant.toObject(),enabledModules:['expenses'],subscription:{...tenant.subscription.toObject(),modules:['expenses']}};
 await assert.rejects(reports.generate(conn,noReport,owner,'daily',{from:today,to:today}),{status:403});
 await assert.rejects(reports.generate(other,tenant,owner,'expenses'),{status:403});
 // Fresh identity and commercial checks reject stale privilege/branch/entitlement snapshots.
 await models.tenantUserModel(conn).updateOne({_id:operator.id},{$set:{status:'disabled'},$inc:{authVersion:1}});
 await assert.rejects(expenses.create(conn,tenant,operator,input({paymentMethod:'Bank'})),{status:403});
 await models.tenantUserModel(conn).updateOne({_id:operator.id},{$set:{status:'active',branchId:String(usd._id)},$inc:{authVersion:1}});
 const usdRecord=(await expenses.create(conn,tenant,operator,input({currency:'USD',amount:'12.34',paymentMethod:'Bank'}))).record;
 assert.equal(usdRecord.currency,'USD');assert.equal(String(usdRecord.branchId),String(usd._id));assert.equal(String(usdRecord.amountMinor),'1234');
 assert.equal((await expenses.list(conn,tenant,operator)).items.length,1,'fresh branch assignment limits the list');
 const otherBranch=await user('Mobile Money Operator',String(branch._id));
 assert.equal((await expenses.list(conn,tenant,otherBranch)).items.length,0,'operators cannot see one another expenses');
 await Tenant.updateOne({_id:tenant._id},{$pull:{enabledModules:'expenses'},$inc:{__v:1}});
 await assert.rejects(expenses.create(conn,tenant,operator,input({currency:'USD',paymentMethod:'Bank'})),{status:403});
 assert.equal(await expenseModel(other).countDocuments({}),0);assert.equal(await models.auditEventModel(other).countDocuments({}),0);
 assert.equal(await models.auditEventModel(conn).countDocuments({targetId:first._id}),6,'all expense decisions and changes are audited atomically');
 console.log('PASS: Expenses pending/approval cash effect, exact currencies, correction/void dual control, quota/idempotency, cash close, reports/CSV, fresh authorization and tenant/branch isolation.');
}
async function cleanup(){
 for(const conn of connections){if(!slugs.some(slug=>tenantDbNameFromSlug(slug)===conn.name))throw Error('Unsafe expense scratch cleanup');await conn.dropDatabase();}
 if(mongoose.connection.readyState===1){if(mongoose.connection.name!==scratchName)throw Error('Unsafe platform scratch cleanup');await mongoose.connection.dropDatabase();}
 await mongoose.disconnect();
}
main().catch(error=>{console.error('Expenses/reports integration FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Expense cleanup failed:',error.message);process.exitCode=1;}));
