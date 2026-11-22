#!/usr/bin/env node
'use strict';
// Disposable local MongoDB replica set ONLY. Exercises real loan & airtime
// services, Treasury postings, concurrency, audit, quotas, and tenant isolation.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
require('dotenv').config();
const parsed=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||parsed.protocol!=='mongodb:'||
 !['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||
 parsed.host.includes(',')||parsed.username||parsed.password)
 throw Error('Retail finance integration requires isolated unauthenticated loopback Mongo replica set');
const nonce=crypto.randomBytes(8).toString('hex'),platform='cfh_retail_probe_'+nonce,
 slug='retail-probe-'+nonce;
parsed.pathname='/'+platform;process.env.MONGO_PLATFORM_URI=parsed.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose'),{connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const core=require('../src/tenant/models'),Tenant=require('../src/platform/models/Tenant');
const commerce=require('../src/platform/services/commercial.service');
const treasury=require('../src/tenant/treasury/service'),book=require('../src/tenant/treasury/models');
const ledger=require('../src/tenant/services/ledger.service');
const loan=require('../src/tenant/retailFinance/loans.service'),air=require('../src/tenant/retailFinance/airtime.service');
const loanModel=require('../src/tenant/retailFinance/loans.models'),airModel=require('../src/tenant/retailFinance/airtime.models');
const {customerModel}=require('../src/tenant/customerAccounts/models');
const {permissionsFor}=require('../src/config/roles');
let conn;
const random=()=>crypto.randomUUID(),fmt=id=>String(id);
async function run(){
 await connectPlatformMongo();
 require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 conn=getTenantConnection(slug);
 await Tenant.createIndexes();await core.ensureTenantIndexes(conn);
 await book.ensure(conn);await loanModel.ensure(conn);await airModel.ensure(conn);
 await require('../src/tenant/customerAccounts/models').ensureIndexes(conn);
 const modules=['mobile_money','loans','airtime']; // No Customers subscription: borrower registration is independent.
 const template={code:'retail_scratch',name:'Retail finance scratch',
  description:'Disposable integration test only',currency:'USD',priceMonthly:1,priceYearly:10,
  trialMonths:0,modules,limits:{users:10,branches:2,transactionsPerMonth:500,
   smsPerMonth:0,storageMb:1000}};
 const snapshot=commerce.planSnapshot({...commerce.asPlanVersion(template),status:'published'});
 const tenant=await Tenant.create({name:'Retail finance scratch',slug,dbName:conn.name,
  owner:'Scratch Owner',email:'retail-'+nonce+'@example.invalid',
  plan:template.code,status:'active',setupStatus:'complete',enabledModules:modules,
  seatsReserved:5,branchCount:1,subscription:{...snapshot,generation:1,status:'granted',
   source:'manual_admin_grant',periodStart:new Date(Date.now()-60_000),
   periodEnd:new Date(Date.now()+86_400_000)}});
 const branch=await core.branchModel(conn).create({name:'Retail scratch branch',code:'retail-main',
  currency:'UGX',createdBy:new mongoose.Types.ObjectId(),updatedBy:new mongoose.Types.ObjectId()});
 async function actor(role){
  const user=await core.tenantUserModel(conn).create({name:role,
   email:role.toLowerCase().replaceAll(' ','-')+'-'+nonce+'@example.invalid',
   passwordHash:'not-a-live-password',role,branchId:fmt(branch._id),
   allowedModules:modules,status:'active',mfaEnabledAt:new Date()});
  return {id:fmt(user._id),role,name:role,branchId:fmt(branch._id),
   permissions:permissionsFor(role),allowedModules:modules,authVersion:0};
 }
 const owner=await actor('Tenant Owner'),banker=await actor('Banking Operator'),
  manager=await actor('Branch Manager'),momo=await actor('Mobile Money Operator'),
  auditor=await actor('Auditor');
 const fund=await treasury.createAccount(conn,tenant,owner,{code:'RETAILBANK',name:'Verified bank holdings',
  kind:'bank',currency:'UGX',accountReference:'Scratch bank account'});
 const initial=await treasury.requestObservation(conn,tenant,owner,fund._id,{
  kind:'opening',actualBalance:'100000',observedAt:new Date(Date.now()-5000).toISOString(),
  evidenceType:'bank_statement',evidenceReference:'SCRATCH-BANK-STATEMENT-'+nonce,
  note:'Independent scratch opening from original actual balance evidence',idempotencyKey:random()});
 await treasury.reviewObservation(conn,tenant,manager,initial.observation._id,{
  decision:'approve',note:'Independently verified scratch account opening statement'});
 const balance=async()=>BigInt(String((await book.models(conn).account.findById(fund._id)).bookBalanceMinor));
 assert.equal(await balance(),100000n);
 const borrowerInput={idempotencyKey:random(),name:'Example Borrower',phone:'+211912345678'};
 const borrowerResult=await loan.registerBorrower(conn,tenant,banker,borrowerInput);
 assert.equal(borrowerResult.duplicate,false);
 assert.equal((await loan.registerBorrower(conn,tenant,banker,borrowerInput)).duplicate,true);
 await assert.rejects(loan.registerBorrower(conn,tenant,banker,{...borrowerInput,name:'Different Name'}),e=>e.status===409);
 const borrower=borrowerResult.borrower;
 assert.equal((await customerModel(conn).findById(borrower._id)).name,'Example Borrower');
 const lp=await loan.createProduct(conn,tenant,manager,{name:'30-day scratch loan',currency:'UGX',
  interestBps:'500',termDays:'30',minimum:'500',maximum:'50000'});
 const application={idempotencyKey:random(),customerId:fmt(borrower._id),productId:fmt(lp._id),
  principal:'20000',reason:'Business equipment for verified scratch application'};
 await assert.rejects(loan.apply(conn,tenant,momo,application),e=>e.status===403);
 const issued=await loan.apply(conn,tenant,banker,application);
 assert.equal(issued.duplicate,false);
 assert.equal((await loan.apply(conn,tenant,banker,application)).duplicate,true);
 await assert.rejects(loan.apply(conn,tenant,banker,{...application,principal:'22000'}),e=>e.status===409);
 assert.equal(await balance(),100000n,'Application never subtracts cash');
 await assert.rejects(loan.review(conn,tenant,banker,issued.loan._id,{decision:'approve',
  reason:'Self-approval of the loan would be forbidden.'}),e=>e.status===403);
 await loan.review(conn,tenant,manager,issued.loan._id,{decision:'approve',
  reason:'Second-person borrower verification in scratch scenario'});
 const loanLive=await loan.disburse(conn,tenant,manager,issued.loan._id,{accountId:fmt(fund._id),
  reference:'BANK-LOAN-DISB-'+nonce});
 assert.equal(loanLive.status,'active');
 assert.equal(await balance(),80000n,'Disbursement subtracts actual bank funds');
 const repayInput={idempotencyKey:random(),accountId:fmt(fund._id),amount:'11000',
  reference:'BANK-LOAN-REPAY-'+nonce};
 const repayment=await loan.repay(conn,tenant,banker,issued.loan._id,repayInput);
 assert.equal(String(repayment.payment.interestMinor),'1000','Interest collected separately');
 assert.equal(String(repayment.payment.principalMinor),'10000');
 assert.equal((await loan.repay(conn,tenant,banker,issued.loan._id,repayInput)).duplicate,true);
 assert.equal(await balance(),91000n);
 await assert.rejects(loan.repay(conn,tenant,banker,issued.loan._id,{...repayInput,
  idempotencyKey:random(),amount:'12000'}),e=>e.status===409);
 await loan.repay(conn,tenant,manager,issued.loan._id,{...repayInput,
  idempotencyKey:random(),amount:'10000',reference:'BANK-LOAN-FINAL-'+nonce});
 assert.equal(await balance(),101000n);
 assert.equal((await loanModel.models(conn).loan.findById(issued.loan._id).lean()).status,'paid');
 const product=await air.createProduct(conn,tenant,owner,{network:'MTN',name:'MTN 1000',
  denomination:'1000',cost:'600',price:'1000',currency:'UGX'});
 const stockInput={idempotencyKey:random(),network:'MTN',currency:'UGX',
  cost:'6000',accountId:fmt(fund._id),reference:'MTN-STOCK-INVOICE-'+nonce};
 const purchase=await air.purchase(conn,tenant,owner,stockInput);
 assert.equal(purchase.duplicate,false);
 assert.equal((await air.purchase(conn,tenant,owner,stockInput)).duplicate,true);
 assert.equal(await balance(),95000n);
 const saleInput={idempotencyKey:random(),productId:fmt(product._id),phone:'+211912345678',
  accountId:fmt(fund._id),reference:'MTN-DELIVERY-'+nonce,deliveryConfirmed:'yes'};
 await assert.rejects(air.sell(conn,tenant,momo,{...saleInput,deliveryConfirmed:''}),e=>e.status===409);
 const sale=await air.sell(conn,tenant,momo,saleInput);
 assert.equal(String(sale.record.profitMinor),'400');
 assert.equal((await air.sell(conn,tenant,momo,saleInput)).duplicate,true);
 assert.equal(await balance(),96000n);
 // Check the records actually shown on printable business receipts.
 const receipts=require('../src/tenant/retailFinance/receipts.service');
 const [repayReceipt,airReceipt]=await Promise.all([
  receipts.loanPayment(conn,tenant,auditor,issued.loan._id,repayment.payment._id),
  receipts.airtimeSale(conn,tenant,momo,sale.record._id)
 ]);
 assert.equal(repayReceipt.reference,repayment.payment.reference);
 assert(repayReceipt.lines.some(line=>line[0]==='Interest allocated'&&line[1].includes('1,000')));
 assert.equal(repayReceipt.timeZone,'Africa/Kampala');
 assert.equal(repayReceipt.reversed,false);
 assert.equal(airReceipt.reference,sale.record.reference);
 assert(airReceipt.lines.some(line=>line[0]==='Sale amount'&&line[1].includes('1,000')));
 assert.equal(airReceipt.reversed,false);
 assert.match(airReceipt.warning,/not proof of a successful telecom top-up/);
 await assert.rejects(receipts.loanPayment(conn,tenant,momo,issued.loan._id,repayment.payment._id),e=>e.status===403);
 await assert.rejects(receipts.airtimeSale(conn,tenant,momo,repayment.payment._id),e=>e.status===404);
 const report=await air.list(conn,tenant,owner);
 assert.equal(String(report.inventory[0].costBalanceMinor),'5400');
 assert.equal(report.summary[0].profit,'400');
 const portfolio=await loan.list(conn,tenant,auditor);
 assert.equal(portfolio.summary[0].principalOutstanding,'0');
 assert.equal((await ledger.trialBalance(conn,{branchId:fmt(branch._id),currency:'UGX'})).balanced,true);
 // Financial corrections retain original immutable payments and sale evidence.
 // Reverse in reverse chronological order so inventory and loan allocations
 // cannot silently change prior evidence. Every reversal touches Treasury once.
 const reversedSale=await air.reverseRecorded(conn,tenant,manager,sale.record._id,{
  reason:'Telecom transaction was successfully cancelled and verified',
  reference:'REFUNDED-MTN-SALE-'+nonce,providerReversed:'yes',fundsReturned:'yes'});
 assert.equal(reversedSale.type,'sale');
 assert.equal((await receipts.airtimeSale(conn,tenant,momo,sale.record._id)).reversed,true);
 assert.equal(await balance(),95000n);
 assert.equal(String((await airModel.models(conn).inventory.findById(sale.record.inventoryId)).costBalanceMinor),'6000');
 assert.equal((await air.list(conn,tenant,owner)).summary[0].profit,'0');
 await assert.rejects(air.reverseRecorded(conn,tenant,manager,sale.record._id,{
  reason:'Already refunded and recorded on its source ledger',
  reference:'REFUNDED-MTN-SALE-'+nonce,providerReversed:'yes',fundsReturned:'yes'}),e=>e.status===409);
 await assert.rejects(air.reverseRecorded(conn,tenant,owner,purchase.record._id,{
  reason:'The original purchaser cannot independently approve the supplier refund',
  reference:'REFUNDED-MTN-STOCK-'+nonce,providerReversed:'yes',fundsReturned:'yes'}),e=>e.status===409);
 await air.reverseRecorded(conn,tenant,manager,purchase.record._id,{
  reason:'Unused bulk stock fully returned to its source supplier',
  reference:'REFUNDED-MTN-STOCK-'+nonce,providerReversed:'yes',fundsReturned:'yes'});
 assert.equal(await balance(),101000n);
 assert.equal(String((await airModel.models(conn).inventory.findById(sale.record.inventoryId)).costBalanceMinor),'0');
 const loanPayments=await loanModel.models(conn).payment.find({loanId:issued.loan._id}).sort({createdAt:-1,_id:-1}).lean();
 const lastPayment=loanPayments[0],firstPayment=loanPayments[1];
 assert.equal(String(lastPayment.createdBy),manager.id);
 await assert.rejects(loan.reverseRepayment(conn,tenant,manager,issued.loan._id,lastPayment._id,{
  reason:'A reviewer cannot independently approve their own repayment refund',
  reference:'REFUNDED-LOAN-LAST-'+nonce}),e=>e.status===409);
 await loan.reverseRepayment(conn,tenant,owner,issued.loan._id,lastPayment._id,{
  reason:'Confirmed duplicate remittance was refunded to the original borrower',
  reference:'REFUNDED-LOAN-LAST-'+nonce});
 assert.equal(await balance(),91000n);
 assert.equal((await loanModel.models(conn).loan.findById(issued.loan._id)).status,'active');
 await assert.rejects(loan.reverseRepayment(conn,tenant,manager,issued.loan._id,lastPayment._id,{
  reason:'Already refunded and cannot reverse a repayment a second time',
  reference:'REFUNDED-LOAN-LAST-'+nonce}),e=>e.status===409);
 await loan.reverseRepayment(conn,tenant,manager,issued.loan._id,firstPayment._id,{
  reason:'Earlier borrower payment fully refunded on verified evidence',
  reference:'REFUNDED-LOAN-FIRST-'+nonce});
 assert.equal(await balance(),80000n);
 assert.equal((await receipts.loanPayment(conn,tenant,auditor,issued.loan._id,repayment.payment._id)).reversed,true);
 const restoredLoan=await loanModel.models(conn).loan.findById(issued.loan._id).lean();
 assert.equal(String(restoredLoan.principalOutstandingMinor),'20000');
 assert.equal(String(restoredLoan.interestOutstandingMinor),'1000');
 const dateRange={$gte:new Date(Date.now()-3600000),$lt:new Date(Date.now()+3600000)};
 const adapters=require('../src/tenant/reporting/registry');
 const sourceRows=await Promise.all(['loans','airtime'].map(key=>
  adapters.find(a=>a.key===key).rows({conn,scope:{branchId:fmt(branch._id)},dateRange})));
 assert(sourceRows[0].some(row=>row.status==='refunded'),'Loan corrections visible in reports');
 assert(sourceRows[1].some(row=>row.status==='refunded'),'Airtime corrections visible in reports');
 const postedIncome=await require('../src/tenant/services/approvedReports.service').postedIncome(
  conn,tenant,{branchId:fmt(branch._id)},dateRange,[{key:'loans'},{key:'airtime'}]);
 assert.equal(postedIncome.length,0,'Refunded interest and airtime profit must not remain as realized income');
 assert.equal((await ledger.trialBalance(conn,{branchId:fmt(branch._id),currency:'UGX'})).balanced,true);
 await Tenant.updateOne({_id:tenant._id},{$set:{enabledModules:['mobile_money']}});
 await assert.rejects(air.list(conn,tenant,owner),e=>e.status===403,'Revoked airtime module cannot read');
 await assert.rejects(loan.list(conn,tenant,owner),e=>e.status===403,'Revoked loans module cannot read');
 await assert.rejects(receipts.loanPayment(conn,tenant,auditor,issued.loan._id,repayment.payment._id),e=>e.status===403,'Revoked loan receipt access fails closed');
 await assert.rejects(receipts.airtimeSale(conn,tenant,momo,sale.record._id),e=>e.status===403,'Revoked airtime receipt access fails closed');
 await assert.rejects(loan.repay(conn,tenant,banker,issued.loan._id,repayInput),
  e=>e.status===403,'Revoked repayment access must also block idempotent retries');
 console.log('PASS: loan independent review and real account debits; principal + interest collection; airtime stock and profit, idempotency, receipt evidence, scoped printouts, corrected labels, balanced journals, tenant permissions and revocation');
}
async function cleanup(){
 if(mongoose.connection.readyState===1&&mongoose.connection.name===platform&&/^cfh_retail_probe_[0-9a-f]{16}$/.test(platform)){
  if(conn)await conn.db.dropDatabase();
  await mongoose.connection.db.dropDatabase();
 }
 await mongoose.disconnect();
}
run().catch(e=>{console.error('RETAIL FINANCE SCRATCH TEST FAILED:',e.stack||e.message);process.exitCode=1;})
 .finally(()=>cleanup().catch(e=>{console.error('Scratch cleanup:',e.message);process.exitCode=1;}));
