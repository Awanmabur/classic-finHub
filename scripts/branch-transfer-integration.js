#!/usr/bin/env node
'use strict';
// Real financial transactions, mocked provider only. Random loopback scratch DBs.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Transfer SMS integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),platformName=`cfh_branch_transfer_${nonce}`,slug=`branch-transfer-${nonce}`;
configured.pathname='/'+platformName;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
process.env.MFA_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');process.env.TRANSFER_SMS_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');process.env.TRANSFER_SMS_PROVIDER='twilio';
// No real transport credentials are used. Every processOne below has a mock.
delete process.env.TWILIO_ACCOUNT_SID;delete process.env.TWILIO_AUTH_TOKEN;delete process.env.TWILIO_FROM_NUMBER;delete process.env.TWILIO_MESSAGING_SERVICE_SID;
const mongoose=require('mongoose'),core=require('../src/tenant/models'),Tenant=require('../src/platform/models/Tenant');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const funded=require('../src/tenant/services/fundedOperations.service'),fundedModels=require('../src/tenant/funded/models'),pin=require('../src/tenant/funded/pin');
const transfer=require('../src/tenant/services/moneyTransfer.service'),treasury=require('../src/tenant/treasury/service'),cash=require('../src/tenant/services/cashDrawer.service');
const sms=require('../src/tenant/transferSms/service'),smsModels=require('../src/tenant/transferSms/models'),smsCrypto=require('../src/tenant/transferSms/crypto');
const commerce=require('../src/platform/services/commercial.service'),{permissionsFor}=require('../src/config/roles');
const {transferQueueCounts}=require('./notification-doctor');
let conn;
const oid=()=>String(new mongoose.Types.ObjectId()),owner={id:oid(),role:'Tenant Owner',permissions:['*'],allowedModules:['money_transfer'],authVersion:0},teller={id:oid(),role:'Money Transfer Operator',permissions:permissionsFor('Money Transfer Operator'),allowedModules:['money_transfer'],authVersion:0};
const decision={decision:'approve',note:'Independent source evidence and actual counted funds reviewed'};
const input=()=>({idempotencyKey:crypto.randomUUID(),evidenceReference:'ACTUAL-COUNT-'+nonce,note:'Actual collected cash and signed transfer instruction inspected'});
const delivered=[];
const transport=async value=>{delivered.push(value);return {status:'accepted',messageId:'SM'+'a'.repeat(32),providerState:'queued'};};
function workerCredentials(){process.env.TWILIO_ACCOUNT_SID='AC'+'1'.repeat(32);process.env.TWILIO_AUTH_TOKEN='2'.repeat(32);process.env.TWILIO_FROM_NUMBER='+256700999000';}
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Tenant.createIndexes();await require('../src/platform/models/LoginThrottle').createIndexes();conn=getTenantConnection(slug);await funded.prepareIndexes(conn);
 const terms=commerce.planSnapshot({...commerce.asPlanVersion({...require('../src/data/store').plans.find(plan=>plan.code==='enterprise'),code:'transfer_sms_probe',modules:['money_transfer']}),status:'published'});
 const tenant=await Tenant.create({name:'SMS transfer proof',slug,dbName:conn.name,owner:'Owner',email:`${nonce}@example.invalid`,plan:terms.planCode,status:'active',setupStatus:'complete',enabledModules:['money_transfer'],seatsReserved:2,branchCount:1,subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const branch=await core.branchModel(conn).create({name:'Main payout office',code:'main',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
 owner.branchId=teller.branchId=String(branch._id);
 for(const actor of [owner,teller])await core.tenantUserModel(conn).create({_id:actor.id,name:actor.role,email:`${actor.id}@example.invalid`,passwordHash:'isolated-test-only',role:actor.role,branchId:branch._id,allowedModules:['money_transfer'],authVersion:0,...(actor===owner?{mfaEnabledAt:new Date()}: {})});
 async function opened(kind,code,balance,operatorId){const account=await treasury.createAccount(conn,tenant,owner,{kind,code,name:code,currency:'UGX',isDefault:true,...(operatorId?{operatorId}:{})});const observation=await treasury.requestObservation(conn,tenant,teller,account._id,{kind:'opening',actualBalance:balance,observedAt:new Date(Date.now()-1000).toISOString(),evidenceType:kind==='cash'?'cash_count':'transfer_register',evidenceReference:'OPEN-'+code,note:'Actual original balances independently counted before operating',idempotencyKey:crypto.randomUUID()});await treasury.reviewObservation(conn,tenant,owner,observation.observation._id,decision);return account;}
 const drawer=await opened('cash','TELLER_CASH','1000000',teller.id),payable=await opened('transfer_clearing','TRANSFER_PAYABLE','0');
 const shift=await cash.open(conn,tenant,teller,{openingCash:'1000000'});await cash.decideOpening(conn,tenant,owner,shift._id,decision);
 async function request(){const source=(await transfer.createRequest(conn,tenant,teller,{senderName:'Typed Sender',senderPhone:'+256700111222',senderCountry:'UG',receiverName:'Typed Receiver',receiverPhone:'+256700123456',receiverCountry:'UG',currency:'UGX',amount:'10000',fee:'100',transferMethod:'Cash',idempotencyKey:crypto.randomUUID()})).order;const collection=(await funded.request(conn,tenant,teller,'money_transfer',source._id,input())).execution;return {source,collection};}

 const destination=await core.branchModel(conn).create({name:'Receiving branch',code:'receiving',currency:'UGX',currencies:['UGX','SSP'],createdBy:owner.id,updatedBy:owner.id});
 const receivingTeller={...teller,id:oid(),branchId:String(destination._id)},manager={id:oid(),role:'Branch Manager',permissions:permissionsFor('Branch Manager'),allowedModules:['money_transfer'],branchId:String(destination._id),authVersion:0};
 for(const actor of [receivingTeller,manager])await core.tenantUserModel(conn).create({_id:actor.id,name:actor.role,email:`${actor.id}@example.invalid`,passwordHash:'test-only',role:actor.role,branchId:actor.branchId,allowedModules:actor.allowedModules,authVersion:0,...(actor===manager?{mfaEnabledAt:new Date()}: {})});
 const destinationCash=await treasury.createAccount(conn,tenant,owner,{kind:'cash',code:'DESTINATION_CASH',name:'Receiving teller drawer',currency:'UGX',operatorId:receivingTeller.id,isDefault:true},{configurationBranchId:String(destination._id)});
 const opening=await treasury.requestObservation(conn,tenant,receivingTeller,destinationCash._id,{kind:'opening',actualBalance:'50000',observedAt:new Date(Date.now()-1000).toISOString(),evidenceType:'cash_count',evidenceReference:'DESTINATION-OPEN',note:'Actual receiving drawer cash physically counted',idempotencyKey:crypto.randomUUID()});
 await treasury.reviewObservation(conn,tenant,manager,opening.observation._id,decision);
 const destinationShift=await cash.open(conn,tenant,receivingTeller,{openingCash:'50000'});await cash.decideOpening(conn,tenant,manager,destinationShift._id,decision);
 const reservedDestination=await core.branchModel(conn).create({name:'Reserved receiving office',code:'reserved',currency:'UGX',currencies:['UGX','SSP'],createdBy:owner.id,updatedBy:owner.id});
 await transfer.createRequest(conn,tenant,teller,{senderName:'Reserved Sender',senderPhone:'+211921234567',receiverName:'Reserved Receiver',receiverPhone:'+211922345678',currency:'SSP',amount:'5.00',fee:'0',destinationBranchId:String(reservedDestination._id),idempotencyKey:crypto.randomUUID()});
 const branchService=require('../src/tenant/services/branch.service');await assert.rejects(branchService.update(tenant,owner,String(reservedDestination._id),{name:reservedDestination.name,address:'',currencies:['UGX'],currenciesConfigured:'true'}),{status:409},'incoming uncollected orders retain their destination currency');await assert.rejects(branchService.archive(tenant,owner,String(reservedDestination._id)),{status:409},'incoming transfer history prevents destination archival');
 const sourceInput={senderName:'Sending Customer',senderPhone:'+211921234567',receiverName:'Receiving Customer',receiverPhone:'+211922345678',currency:'UGX',amount:'10000',fee:'100',transferMethod:'Cash',destinationBranchId:String(destination._id),idempotencyKey:crypto.randomUUID()};
 await assert.rejects(transfer.createRequest(conn,tenant,teller,{...sourceInput,destinationBranchId:oid()}),{status:409});
 await assert.rejects(transfer.createRequest(conn,tenant,teller,{...sourceInput,branchId:String(destination._id)}),{status:403});
 const source=(await transfer.createRequest(conn,tenant,teller,sourceInput)).order;assert((await transfer.createRequest(conn,tenant,teller,sourceInput)).duplicate);
 await assert.rejects(transfer.createRequest(conn,tenant,teller,{...sourceInput,destinationBranchId:String(branch._id)}),{status:409});
 const collection=(await funded.request(conn,tenant,teller,'money_transfer',source._id,input())).execution;await funded.review(conn,tenant,owner,collection._id,decision);
 const secret=await funded.revealPin(conn,tenant,teller,collection._id);assert.equal((await fundedModels.models(conn).execution.findById(collection._id)).pinLookupVersion,'sender_destination_v3');
 await assert.rejects(funded.checkPayout(conn,tenant,teller,{pin:secret.pin,senderPhone:sourceInput.senderPhone}),{status:404},'sending branch cannot pay a destination-bound PIN');
 const checked=await funded.checkPayout(conn,tenant,receivingTeller,{pin:secret.pin,senderPhone:sourceInput.senderPhone,receiverNameCheck:sourceInput.receiverName});
 const payout=(await funded.requestPayout(conn,tenant,receivingTeller,{...input(),verificationToken:checked.token,payoutAccountId:String(destinationCash._id)})).execution;
 const amount=async id=>String((await treasury.models(conn).account.findById(id)).bookBalanceMinor);
 assert.equal(await amount(destinationCash._id),'50000');assert.equal(await amount(payable._id),'10000');
 await assert.rejects(funded.review(conn,tenant,receivingTeller,payout._id,decision),{status:403});
 const Audit=core.auditEventModel(conn),original=Audit.create;Audit.create=function(rows,options){if(rows.some(row=>row.action==='funded.manual.posted'))throw Error('Controlled atomic rollback');return original.call(this,rows,options);};
 try{await assert.rejects(funded.review(conn,tenant,manager,payout._id,decision),/Controlled atomic rollback/);}finally{Audit.create=original;}
 assert.equal(await amount(destinationCash._id),'50000');assert.equal(await amount(payable._id),'10000');
 // A departure of the sending teller does not make already collected funds disappear.
 await core.tenantUserModel(conn).updateOne({_id:teller.id},{$set:{status:'disabled'},$inc:{authVersion:1}});
 const results=await Promise.allSettled([funded.review(conn,tenant,manager,payout._id,decision),funded.review(conn,tenant,manager,payout._id,decision)]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.filter(row=>row.status==='rejected').length,1);
 assert.equal(await amount(destinationCash._id),'40000');assert.equal(await amount(payable._id),'0');assert.equal((await core.transferOrderModel(conn).findById(source._id)).status,'paid_out_manual');
 const balances=await transfer.branchBalances(conn,tenant,manager);assert.equal(balances.rows.length,1);assert.match(balances.rows[0].receivable,/10,000/);await assert.rejects(transfer.branchBalances(conn,tenant,receivingTeller),{status:403});
 const ledger=require('../src/tenant/services/ledger.service');for(const row of [branch,destination])assert.equal((await ledger.trialBalance(conn,{branchId:String(row._id),currency:'UGX'})).balanced,true);
 for(const row of await core.ledgerJournalModel(conn).find({}).lean())assert((await ledger.inspectJournal(conn,row._id)).valid);
 for(const account of [drawer,payable,destinationCash])await treasury.assertBookIntegrity(conn,null,await treasury.models(conn).account.findById(account._id).lean());
 await assert.rejects(funded.checkPayout(conn,tenant,receivingTeller,{pin:secret.pin,senderPhone:sourceInput.senderPhone}),{status:404});
 assert.equal((await transfer.detail(conn,tenant,receivingTeller,source._id)).reference,source.reference);
 console.log('PASS: destination-bound branch PINs, real destination cash, balanced interbranch receivable/payable journals, revoked sender, rollback, concurrent single payout, branch isolation and book integrity. No live SMS sent.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_branch_transfer_[a-f0-9]{16}$/.test(platformName)){if(conn?.name===require('../src/config/tenantDatabaseName').tenantDbNameFromSlug(slug))await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('BRANCH TRANSFER INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Transfer SMS scratch cleanup failed:',error.message);process.exitCode=1;}));
