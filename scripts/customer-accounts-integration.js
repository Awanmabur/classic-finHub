#!/usr/bin/env node
'use strict';
// Uses only random scratch databases on one unauthenticated loopback replica set.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Customer accounts integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),scratchName=`cfh_customer_probe_${nonce}`,slugs=[`probe-directory-a-${nonce}`,`probe-directory-b-${nonce}`];
configured.pathname='/'+scratchName;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const Tenant=require('../src/platform/models/Tenant'),Usage=require('../src/platform/models/UsageCounter');
const models=require('../src/tenant/models'),directory=require('../src/tenant/customerAccounts/models'),service=require('../src/tenant/customerAccounts/service');
const commerce=require('../src/platform/services/commercial.service'),{permissionsFor}=require('../src/config/roles');
const {csvCell}=require('../src/tenant/services/mobileMoney.service');
let connections=[];
const oid=()=>new mongoose.Types.ObjectId();
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),Usage.createIndexes()]);
 connections=slugs.map(getTenantConnection);await Promise.all(connections.map(models.ensureTenantIndexes));const [conn,other]=connections;
 const ownerRow=await models.tenantUserModel(conn).create({name:'Directory owner',email:`owner-${nonce}@example.invalid`,passwordHash:'integration-only-hash',role:'Tenant Owner'});
 const [branch,second]=await models.branchModel(conn).create([{name:'Primary branch',code:'primary',currency:'USD',createdBy:ownerRow._id,updatedBy:ownerRow._id},{name:'Second branch',code:'second',currency:'UGX',createdBy:ownerRow._id,updatedBy:ownerRow._id}]);
 await models.tenantUserModel(conn).updateOne({_id:ownerRow._id},{$set:{branchId:String(branch._id)}});
 const modules=['customers','accounts','mobile_money','money_transfer','banking'];
 const version=commerce.asPlanVersion({...require('../src/data/store').plans.find(p=>p.code==='enterprise'),modules});
 const snapshot=commerce.planSnapshot({...version,status:'published'});
 const tenant=await Tenant.create({name:'Directory integration',slug:slugs[0],dbName:conn.name,owner:ownerRow.name,email:ownerRow.email,plan:version.code,status:'active',setupStatus:'complete',enabledModules:modules,seatsReserved:5,branchCount:2,
  subscription:{...snapshot,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const owner={id:String(ownerRow._id),name:ownerRow.name,role:'Tenant Owner',permissions:['*'],branchId:String(branch._id)};
 const managerRow=await models.tenantUserModel(conn).create({name:'Branch manager',email:`manager-${nonce}@example.invalid`,passwordHash:'integration-only-hash',role:'Branch Manager',branchId:String(second._id),allowedModules:modules});
 const manager={id:String(managerRow._id),role:'Branch Manager',branchId:String(second._id),allowedModules:modules,permissions:permissionsFor('Branch Manager')};
 const bankerRow=await models.tenantUserModel(conn).create({name:'Banking operator',email:`banker-${nonce}@example.invalid`,passwordHash:'integration-only-hash',role:'Banking Operator',branchId:String(branch._id),allowedModules:['accounts','customers','banking']});
 const banker={id:String(bankerRow._id),role:'Banking Operator',branchId:String(branch._id),allowedModules:['accounts','customers','banking'],permissions:permissionsFor('Banking Operator')};
 const customerBody={idempotencyKey:crypto.randomUUID(),reference:'CUS-'+nonce.toUpperCase(),name:'=SUM(1,1)',phone:'+256 (700) 123-456',email:'person@example.invalid',identityNumber:'PRIVATE-PASSPORT-123',type:'Individual',nextOfKinName:'Private Next Kin',nextOfKinPhone:'+256700555666',relationship:'Sibling',country:'Uganda',city:'Kampala',note:'PRIVATE NOTE DO NOT EXPORT'};
 const first=await service.customerCreate(conn,tenant,owner,customerBody),customer=first.record;
 assert.equal(first.duplicate,false);assert.equal(customer.phone,'+256700123456');assert.equal(String(customer.branchId),String(branch._id));
 assert.equal((await service.customerCreate(conn,tenant,owner,customerBody)).duplicate,true);
 await assert.rejects(service.customerCreate(conn,tenant,owner,{...customerBody,name:'Changed customer'}),{status:409});
 await assert.rejects(service.customerCreate(conn,tenant,owner,{...customerBody,idempotencyKey:crypto.randomUUID(),branchId:String(second._id)}),{status:403});
 assert.equal(await directory.customerModel(conn).countDocuments(),1);assert.equal(await models.auditEventModel(conn).countDocuments({action:'customer.created'}),1);
 await service.customerCreate(conn,tenant,manager,{...customerBody,idempotencyKey:crypto.randomUUID(),reference:'OTHER-'+nonce.toUpperCase(),name:'Other branch customer',phone:'+256700222333'});
 const legacyManager=await models.tenantUserModel(conn).create({name:'Legacy manager',email:`legacy-${nonce}@example.invalid`,passwordHash:'integration-only-hash',role:'Branch Manager',branchId:String(second._id)});
 assert.equal((await service.customerList(conn,tenant,{id:String(legacyManager._id)})).items.length,1,'legacy undefined module restrictions derive fixed-role assignments');
 assert.equal((await service.customerList(conn,tenant,manager)).items.length,1);assert.equal((await service.customerList(conn,tenant,owner)).items.length,2);
 await assert.rejects(service.customerDetail(conn,tenant,manager,customer._id),{status:404});
 await assert.rejects(service.customerUpdate(conn,tenant,manager,customer._id,{...customerBody,revision:0}),{status:409});
 await assert.rejects(service.customerList(other,tenant,owner),{status:403},'tenant database context rejects cross-tenant reads');
 const accountBody={idempotencyKey:crypto.randomUUID(),customerId:String(customer._id),accountNumber:'ACC-'+nonce.toUpperCase(),type:'Current Account',status:'active',officer:'Banking operator',purpose:'Trading income',risk:'Low',openingUSD:'0',overdraftLimit:'0'};
 const account=(await service.accountCreate(conn,tenant,banker,accountBody)).record;
 assert.equal(account.currency,'USD');assert.equal((await service.accountCreate(conn,tenant,banker,accountBody)).duplicate,true);
 assert.equal((await service.accountDetail(conn,tenant,banker,account._id)).balance.minor,'0');assert.equal(await models.ledgerPostingModel(conn).countDocuments(),0);
 await assert.rejects(service.accountCreate(conn,tenant,banker,{...accountBody,idempotencyKey:crypto.randomUUID(),accountNumber:'OPEN-'+nonce.toUpperCase(),openingUSD:'10'}),{status:400});
 const ugxInput={...accountBody,idempotencyKey:crypto.randomUUID(),accountNumber:'CURRENCY-'+nonce.toUpperCase(),currency:'UGX'};
 const ugxAccount=(await service.accountCreate(conn,tenant,banker,ugxInput)).record;
 assert.equal(ugxAccount.currency,'UGX');assert.equal((await models.ledgerAccountModel(conn).findById(ugxAccount.ledgerAccountId)).currency,'UGX');
 assert.equal((await service.accountCreate(conn,tenant,banker,ugxInput)).duplicate,true);
 await assert.rejects(service.accountCreate(conn,tenant,banker,{...ugxInput,currency:'SSP'}),{status:409},'idempotency cannot change account currency');
 await assert.rejects(service.accountCreate(conn,tenant,banker,{...accountBody,idempotencyKey:crypto.randomUUID(),accountNumber:'INVALID-'+nonce.toUpperCase(),currency:'EUR'}),{status:409});
 const usageBefore=await Usage.findOne({tenantId:tenant._id,metric:'customer_accounts'}).lean(),ledgerBefore=await models.ledgerAccountModel(conn).countDocuments(),customerBefore=await directory.customerModel(conn).findById(customer._id).lean();
 await assert.rejects(service.accountCreate(conn,tenant,banker,{...accountBody,idempotencyKey:crypto.randomUUID()}),{status:409},'duplicate account number rolls back ledger mapping and quota');
 assert.equal(await models.ledgerAccountModel(conn).countDocuments(),ledgerBefore);assert.equal((await Usage.findById(usageBefore._id)).quantity,usageBefore.quantity);assert.equal((await directory.customerModel(conn).findById(customer._id)).revision,customerBefore.revision);
 await assert.rejects(service.customerArchive(conn,tenant,owner,customer._id,{revision:customerBefore.revision}),{status:409});assert.equal((await directory.customerModel(conn).findById(customer._id)).status,'active');
 const bridge=require('../src/tenant/customerAccounts/bankingBridge'),banking=require('../src/tenant/services/banking.service');
 const choices=await bridge.choices(conn,tenant,banker,{branchId:String(branch._id)});assert(choices.some(x=>x._id==='account:'+account._id));assert(!JSON.stringify(choices).includes(account.accountNumber),'banking options disclose only the last four account characters');
 const secondAccount=(await service.accountCreate(conn,tenant,banker,{...accountBody,idempotencyKey:crypto.randomUUID(),accountNumber:'DST-'+nonce.toUpperCase()})).record;
 const ugxChoices=await bridge.choices(conn,tenant,banker,{currency:'UGX'});assert(ugxChoices.some(row=>row._id==='account:'+ugxAccount._id));assert(!ugxChoices.some(row=>row._id==='account:'+account._id));
 const bankBody={kind:'deposit_request',sourceId:'account:'+account._id,currency:'USD',amount:'5.25',note:'Customer instruction captured for independent review',validDays:7,idempotencyKey:crypto.randomUUID()};
 await assert.rejects(banking.createRequest(conn,tenant,banker,{...bankBody,sourceId:'account:'+ugxAccount._id,idempotencyKey:crypto.randomUUID()}),{status:409},'a USD instruction cannot use a UGX customer ledger');
 const requested=await banking.createRequest(conn,tenant,banker,bankBody);assert.equal(requested.order.status,'requested');assert.equal(requested.order.source.referenceType,'customer_account');assert.equal(String(requested.order.source.referenceId),String(account._id));assert.equal(requested.order.source.institutionName,'Internal customer account');assert.equal(requested.order.source.last4,account.accountNumber.slice(-4));assert.equal((await banking.createRequest(conn,tenant,banker,bankBody)).duplicate,true);
 assert.equal((await banking.list(conn,tenant,banker)).items.length,1);assert.equal(await models.ledgerPostingModel(conn).countDocuments(),0,'a customer account instruction never posts money');
 const approved=await banking.decide(conn,tenant,owner,requested.order._id,{decision:'approve',note:'Independent account instruction details reviewed'});assert.equal(approved.status,'approved_pending_bank');assert.equal(await models.ledgerPostingModel(conn).countDocuments(),0);
 const transfer=await banking.createRequest(conn,tenant,banker,{...bankBody,kind:'transfer_request',destinationId:'account:'+secondAccount._id,idempotencyKey:crypto.randomUUID()});assert.equal(transfer.order.destination.referenceType,'customer_account');
 const otherCustomer=await directory.customerModel(conn).findOne({branchId:second._id});
 const otherLedger=await models.ledgerAccountModel(conn).create({branchId:second._id,currency:'UGX',code:'OTHER_CUSTOMER',name:'Other customer control',category:'liability',createdBy:owner.id});
 const otherAccount=await directory.accountModel(conn).create({branchId:second._id,customerId:otherCustomer._id,accountNumber:'OTHER-ACC-'+nonce.toUpperCase(),idempotencyKey:crypto.randomUUID(),type:'Current Account',currency:'UGX',ledgerAccountId:otherLedger._id,status:'active',createdBy:owner.id,updatedBy:owner.id});
 await assert.rejects(banking.createRequest(conn,tenant,banker,{...bankBody,sourceId:'account:'+otherAccount._id,idempotencyKey:crypto.randomUUID()}),{status:409});
 await models.tenantUserModel(conn).updateOne({_id:bankerRow._id},{$set:{allowedModules:['banking']}});await assert.rejects(banking.createRequest(conn,tenant,banker,{...bankBody,idempotencyKey:crypto.randomUUID()}),{status:403});await models.tenantUserModel(conn).updateOne({_id:bankerRow._id},{$set:{allowedModules:['customers','accounts','banking']}});
 const accountLive=await directory.accountModel(conn).findById(account._id).lean();await service.accountUpdate(conn,tenant,banker,account._id,{...accountBody,status:'suspended',revision:accountLive.revision});
 assert(!(await bridge.choices(conn,tenant,banker)).some(x=>x._id==='account:'+account._id));await assert.rejects(banking.createRequest(conn,tenant,banker,{...bankBody,idempotencyKey:crypto.randomUUID()}),{status:409});
 const suspended=await directory.accountModel(conn).findById(account._id).lean();await service.accountUpdate(conn,tenant,banker,account._id,{...accountBody,status:'active',revision:suspended.revision});
 assert.equal(await models.ledgerPostingModel(conn).countDocuments(),0);

 // Existing accounting journals are immutable source evidence. These scratch
 // postings demonstrate that directory balances are read from real journals,
 // never opening fields, display fixtures, or unapproved banking requests.
 const cashAccount=await models.ledgerAccountModel(conn).create({branchId:branch._id,currency:'USD',code:'CASH_TEST',name:'Scratch cash control',category:'asset',createdBy:owner.id});
 const journal=await models.ledgerJournalModel(conn).create({branchId:branch._id,currency:'USD',sourceType:'banking',sourceRef:'DIRECTORY-'+nonce,fingerprint:crypto.randomBytes(32).toString('hex'),actorId:owner.id});
 await models.ledgerPostingModel(conn).create([{journalId:journal._id,branchId:branch._id,accountId:cashAccount._id,currency:'USD',lineNo:0,side:'debit',amountMinor:'12345'},{journalId:journal._id,branchId:branch._id,accountId:account.ledgerAccountId,currency:'USD',lineNo:1,side:'credit',amountMinor:'12345'}]);
 const detail=await service.accountDetail(conn,tenant,banker,account._id);assert.equal(detail.balance.minor,'12345');assert.equal(service.formatMinor(detail.balance.minor,'USD'),'USD 123.45');
 assert.equal((await service.movements(conn,tenant,banker,{accountId:String(account._id)})).items.length,1);assert.equal((await service.movements(conn,tenant,manager)).items.length,0);
 await assert.rejects(service.accountUpdate(conn,tenant,banker,account._id,{...accountBody,status:'closed',revision:(await directory.accountModel(conn).findById(account._id)).revision}),error=>error.status===409&&/nonzero ledger balance/.test(error.message));
 assert.equal((await directory.accountModel(conn).findById(account._id)).status,'active');assert.equal(await models.auditEventModel(conn).countDocuments({action:'customer.account.created'}),3);
 // The logbook links only entitled source records and exact recorded phones.
 const mobile=await models.mobileTransactionModel(conn).create({idempotencyKey:crypto.randomUUID(),operation:'cash_in',customer:'Recorded customer',customerPhone:customer.phone,network:'MTN',networkReference:'DIRECTORY-'+nonce,currency:'USD',amountMinor:'500',feeMinor:'0',operatorId:owner.id,branchId:branch._id});
 const logbook=await service.logbook(conn,tenant,owner,{customerId:String(customer._id)});assert(logbook.items.some(x=>String(x._id)===String(mobile._id)));assert(logbook.items.some(x=>x.label==='Account credit'));assert.equal((await service.logbook(conn,tenant,manager)).items.length,0);
 // Authoritative account/tenant state wins over forged or stale caller context.
 const viewer=await models.tenantUserModel(conn).create({name:'Read only',email:`viewer-${nonce}@example.invalid`,passwordHash:'integration-only-hash',role:'Viewer',branchId:String(branch._id),allowedModules:modules});
 await assert.rejects(service.customerCreate(conn,tenant,{...owner,id:String(viewer._id)},{...customerBody,idempotencyKey:crypto.randomUUID(),reference:'FORGED-'+nonce.toUpperCase()}),{status:403});
 await models.tenantUserModel(conn).updateOne({_id:bankerRow._id},{$set:{status:'disabled'},$inc:{authVersion:1}});await assert.rejects(service.accountList(conn,tenant,banker),{status:403});
 await models.tenantUserModel(conn).updateOne({_id:bankerRow._id},{$set:{status:'active',allowedModules:['customers']},$inc:{authVersion:1}});await assert.rejects(service.accountList(conn,tenant,banker),{status:403});
 const exportCursor=await service.customerExport(conn,tenant,owner),exportRows=[];for await(const row of exportCursor)exportRows.push(row);await exportCursor.close();
 assert.equal(exportRows.length,2);assert.equal(exportRows[0].identityNumber,undefined);assert.equal(exportRows[0].nextOfKinName,undefined);assert.equal(exportRows[0].note,undefined);assert(service.EXPORT_FIELDS.includes('phone'));assert.equal(service.EXPORT_FIELDS.includes('identityNumber'),false);
 assert.match(exportRows.map(row=>service.EXPORT_FIELDS.map(k=>csvCell(row[k])).join(',')).join('\r\n'),/'=SUM/);
 const filtered=await service.customerExport(conn,tenant,owner,{q:'Other branch'}),filteredRows=[];for await(const row of filtered)filteredRows.push(row);await filtered.close();assert.equal(filteredRows.length,1);assert.equal(filteredRows[0].name,'Other branch customer');
 await assert.rejects(service.customerExport(conn,tenant,manager),{status:403});await assert.rejects(service.customerExport(other,tenant,owner),{status:403});
 assert(await models.auditEventModel(conn).exists({action:'customer.directory.exported'}));
 await Tenant.updateOne({_id:tenant._id},{$set:{enabledModules:['customers']},$inc:{__v:1}});
 assert.equal((await service.logbook(conn,tenant,owner,{customerId:String(customer._id)})).items.length,0,'stale entitlement cannot leak revoked logbook source data');
 assert.equal((await service.customerList(conn,tenant,owner)).accounts,null,'directory counts respect the separately assigned Accounts module');
 await Tenant.updateOne({_id:tenant._id},{$set:{enabledModules:[]},$inc:{__v:1}});await assert.rejects(service.customerList(conn,tenant,owner),{status:403},'stale tenant snapshot cannot retain revoked module access');
 console.log('PASS: customer/account real writes, audited idempotency, duplicate rollback, fixed branch and exact USD ledger balances, linked logbook/movements, scoped safe CSV and live tenant/staff authorization.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===scratchName&&/^cfh_customer_probe_[a-f0-9]{16}$/.test(scratchName)){for(const conn of connections)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('CUSTOMER ACCOUNTS INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Customer scratch cleanup failed:',error.message);process.exitCode=1;}));
