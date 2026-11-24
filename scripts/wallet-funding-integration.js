#!/usr/bin/env node
'use strict';
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Wallet funding integration requires an isolated local replica set');
const nonce=crypto.randomBytes(7).toString('hex'),platformName=`cfh_wallet_funding_${nonce}`,slug=`wallet-funding-${nonce}`;
configured.pathname='/'+platformName;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose'),core=require('../src/tenant/models'),Tenant=require('../src/platform/models/Tenant');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo'),commerce=require('../src/platform/services/commercial.service'),{permissionsFor}=require('../src/config/roles');
const treasury=require('../src/tenant/treasury/service'),funds=require('../src/tenant/treasury/models'),funding=require('../src/tenant/treasury/funding.service'),fundingModels=require('../src/tenant/treasury/funding.models'),cash=require('../src/tenant/services/cashDrawer.service');
let conn;const oid=()=>String(new mongoose.Types.ObjectId()),owner={id:oid(),name:'Funding Owner',role:'Tenant Owner',permissions:['*'],authVersion:0},operator={id:oid(),name:'Wallet Operator',role:'Mobile Money Operator',permissions:permissionsFor('Mobile Money Operator'),allowedModules:['mobile_money','banking'],authVersion:0},reviewer={id:oid(),name:'Independent Reviewer',role:'Reconciliation Officer',permissions:permissionsFor('Reconciliation Officer'),allowedModules:['mobile_money','banking'],authVersion:0},other={id:oid(),name:'Other Operator',role:'Mobile Money Operator',permissions:permissionsFor('Mobile Money Operator'),allowedModules:['mobile_money','banking'],authVersion:0};
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Tenant.createIndexes();conn=getTenantConnection(slug);await core.ensureTenantIndexes(conn);await funds.ensure(conn);await fundingModels.ensureIndexes(conn);
 const modules=['mobile_money','banking'],terms=commerce.planSnapshot({...commerce.asPlanVersion({...require('../src/data/store').plans.find(plan=>plan.code==='enterprise'),code:'wallet_funding_probe',modules}),status:'published'});
 const tenant=await Tenant.create({name:'Wallet funding proof',slug,dbName:conn.name,owner:'Owner',email:`${nonce}@example.invalid`,plan:'wallet_funding_probe',status:'active',setupStatus:'complete',enabledModules:modules,seatsReserved:4,branchCount:1,subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const branch=await core.branchModel(conn).create({code:'main',name:'Actual branch',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
 const User=core.tenantUserModel(conn);for(const actor of [owner,operator,reviewer,other]){actor.branchId=String(branch._id);await User.create({_id:actor.id,name:actor.name,email:`${actor.id}@example.invalid`,passwordHash:'isolated-only',role:actor.role,branchId:actor.branchId,allowedModules:actor.allowedModules||modules,authVersion:0,...(['Tenant Owner','Reconciliation Officer'].includes(actor.role)?{mfaEnabledAt:new Date()}: {})});}
 async function open(kind,code,balance,{network='',assigned=null,currency='UGX',opener=operator}={}){
  const account=await treasury.createAccount(conn,tenant,owner,{kind,code,name:'Actual '+code,currency,operatorId:assigned,network});
  const response=await treasury.requestObservation(conn,tenant,opener,account._id,{kind:'opening',actualBalance:String(balance),observedAt:new Date(Date.now()-1000).toISOString(),evidenceType:kind==='cash'?'cash_count':kind==='wallet'?'provider_statement':'bank_statement',evidenceReference:'FUNDING-OPEN-'+code,note:'Original actual source inspected before registering the funds account',idempotencyKey:crypto.randomUUID()});
  await treasury.reviewObservation(conn,tenant,reviewer,response.observation._id,{decision:'approve',note:'Independent opening count and statement inspected directly'});return account;
 }
 const bank=await open('bank','BANK_SOURCE',1000),wallet=await open('wallet','MTN_WALLET',100,{network:'MTN',assigned:operator.id}),drawer=await open('cash','CASH_DRAWER',500,{assigned:operator.id}),otherWallet=await open('wallet','OTHER_WALLET',0,{network:'MTN',assigned:other.id,opener:other});
 const balance=async account=>String((await funds.models(conn).account.findById(account._id).lean()).bookBalanceMinor);
 const input=(source,destination,amount,extra={})=>({sourceAccountId:String(source._id),destinationAccountId:String(destination._id),amount:String(amount),evidenceReference:'ACTUAL-TRANSFER-'+crypto.randomBytes(6).toString('hex'),note:'Actual funding transfer checked against the bank or provider receipt',idempotencyKey:crypto.randomUUID(),...extra});
 const contribution=(destination,amount)=>({
  sourceKind:'owner_contribution',destinationAccountId:String(destination._id),amount,
  evidenceReference:`OWNER-RECEIPT-${crypto.randomBytes(6).toString('hex')}`,idempotencyKey:crypto.randomUUID()
 });
 const decide=(record,actor=reviewer,extra={})=>funding.review(conn,tenant,actor,record._id,{decision:'approve',note:'The independent source and destination receipt match the transfer',...extra});
 const initial=input(bank,wallet,200),requested=await funding.request(conn,tenant,operator,initial);
 assert.equal(requested.funding.status,'pending_review');assert.equal(await balance(bank),'1000');assert.equal(await balance(wallet),'100');
 await fundingModels.model(conn).collection.updateOne({_id:requested.funding._id},{$unset:{sourceKind:''}});
 assert.equal((await funding.request(conn,tenant,operator,initial)).duplicate,true);await assert.rejects(funding.request(conn,tenant,operator,{...initial,amount:'201'}),{status:409});
 await assert.rejects(decide(requested.funding,operator),{status:403});
 const posted=await decide(requested.funding);assert.equal(posted.funding.status,'posted');assert.equal(await balance(bank),'800');assert.equal(await balance(wallet),'300');assert(posted.funding.batchId);assert(posted.funding.journalIds.length);
 assert.equal((await decide(requested.funding)).duplicate,true);assert.equal(await funds.models(conn).batch.countDocuments({sourceType:'treasury_funding'}),1);
 assert.equal(BigInt(await balance(bank))+BigInt(await balance(wallet)),1100n,'funding conserves real assets');
 const selfRequested=await funding.request(conn,tenant,owner,input(bank,wallet,10));
 const selfDenied=await funding.review(conn,tenant,owner,selfRequested.funding._id,{decision:'reject',note:'Owner rejects preparatory request without moving actual funds'});
 assert.equal(selfDenied.funding.status,'rejected','owner may decide own routine request');
 const cashRequest=await funding.request(conn,tenant,operator,input(drawer,wallet,100));await assert.rejects(decide(cashRequest.funding),error=>error.status===409&&/drawer|shift/i.test(error.message));assert.equal(await balance(drawer),'500');
 await assert.rejects(funding.request(conn,tenant,operator,contribution(drawer,'20')),error=>error.status===409&&/drawer|shift/i.test(error.message));
 const shift=await cash.open(conn,tenant,operator,{openingCash:'500'});await cash.decideOpening(conn,tenant,reviewer,shift._id,{decision:'approve',note:'Opening cash physically counted and independently confirmed'});await decide(cashRequest.funding);assert.equal(await balance(drawer),'400');assert.equal(await balance(wallet),'400');
 assert.equal(String((await core.cashSessionModel(conn).findById(shift._id)).provisionalMovementMinor),'-100','funding changes physical drawer exactly once');
 await assert.rejects(funding.request(conn,tenant,operator,input(bank,wallet,999999)),{status:409});
 const tooLarge=await funding.request(conn,tenant,operator,input(bank,wallet,600));await decide((await funding.request(conn,tenant,operator,input(bank,wallet,300))).funding);const beforeInsufficient=await balance(wallet);await assert.rejects(decide(tooLarge.funding),{status:409});assert.equal(await balance(wallet),beforeInsufficient);assert.equal(await balance(bank),'500');
 await assert.rejects(funding.request(conn,tenant,operator,input(bank,otherWallet,10)),error=>[403,404].includes(error.status));await assert.rejects(funding.request(conn,tenant,owner,input(drawer,otherWallet,10)),{status:403});
 const behalf=await funding.request(conn,tenant,owner,input(bank,otherWallet,50));assert.equal(String(behalf.funding.operatingActorId),other.id);await decide(behalf.funding);assert.equal(await balance(otherWallet),'50');assert.equal(await balance(bank),'450');
 const revoked=await funding.request(conn,tenant,operator,input(bank,wallet,20));await User.updateOne({_id:operator.id},{$inc:{authVersion:1}});await assert.rejects(decide(revoked.funding),{status:403});assert.equal(await balance(bank),'450');await User.updateOne({_id:operator.id},{$set:{authVersion:0}});
 const heldRequest=await funding.request(conn,tenant,operator,input(bank,wallet,10));const actual=await balance(wallet);const discrepancy=await treasury.requestObservation(conn,tenant,operator,wallet._id,{kind:'checkpoint',actualBalance:String(BigInt(actual)-1n),observedAt:new Date().toISOString(),evidenceType:'provider_app',evidenceReference:'FUNDING-UNRESOLVED-CHECK',note:'Actual provider balance differs and must be investigated separately',idempotencyKey:crypto.randomUUID()});assert(discrepancy.observation);await assert.rejects(decide(heldRequest.funding),{status:409});
 const matching=await treasury.requestObservation(conn,tenant,operator,wallet._id,{kind:'checkpoint',actualBalance:actual,observedAt:new Date().toISOString(),evidenceType:'provider_statement',evidenceReference:'FUNDING-CONFIRMED-CHECK',note:'Independent statement identifies the current correct network balance',idempotencyKey:crypto.randomUUID()});await treasury.reviewObservation(conn,tenant,reviewer,matching.observation._id,{decision:'approve',note:'The independent current provider statement matches the book'});
 const concurrent=await funding.request(conn,tenant,operator,input(bank,wallet,25));const beforeConcurrent=BigInt(await balance(bank)),results=await Promise.allSettled([decide(concurrent.funding),decide(concurrent.funding,owner,{note:'Owner independently confirms the same source and destination evidence'})]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(BigInt(await balance(bank)),beforeConcurrent-25n);
 const rollback=await funding.request(conn,tenant,operator,input(bank,wallet,15)),Audit=core.auditEventModel(conn),originalCreate=Audit.create;
 const beforeRollback={bank:await balance(bank),wallet:await balance(wallet),batches:await funds.models(conn).batch.countDocuments(),journals:await core.ledgerJournalModel(conn).countDocuments()};
 Audit.create=async function(rows,...args){if(rows[0]?.action==='treasury.funding.posted')throw Error('Injected final funding audit failure');return originalCreate.call(this,rows,...args);};
 try{await assert.rejects(decide(rollback.funding),/Injected final funding audit failure/);}finally{Audit.create=originalCreate;}
 assert.deepEqual({bank:await balance(bank),wallet:await balance(wallet),batches:await funds.models(conn).batch.countDocuments(),journals:await core.ledgerJournalModel(conn).countDocuments()},beforeRollback);assert.equal((await fundingModels.model(conn).findById(rollback.funding._id)).status,'pending_review');
 const centsBank=await open('bank','KES_BANK','123.45',{currency:'KES'}),centsWallet=await open('wallet','KES_WALLET','0',{currency:'KES',network:'M-Pesa',assigned:operator.id});await decide((await funding.request(conn,tenant,operator,input(centsBank,centsWallet,'10.25'))).funding);assert.equal(await balance(centsBank),'11320');assert.equal(await balance(centsWallet),'1025');await assert.rejects(funding.request(conn,tenant,operator,input(bank,centsWallet,'1')),{status:409});
 assert((await funding.list(conn,tenant,operator)).every(row=>String(row.operatingActorId)===operator.id));assert(!(await funding.list(conn,tenant,other)).some(row=>String(row._id)===String(posted.funding._id)));
 await assert.rejects(funding.request(conn,{...tenant.toObject(),slug:'wrong-tenant'},operator,input(bank,wallet,1)),{status:403});
 const ledger=require('../src/tenant/services/ledger.service');assert.equal((await ledger.trialBalance(conn,{branchId:branch._id,currency:'UGX'})).balanced,true);assert.equal((await ledger.trialBalance(conn,{branchId:branch._id,currency:'KES'})).balanced,true);
 const east=await core.branchModel(conn).create({code:'east',name:'East setup branch',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
 const eastReviewer={...reviewer,id:oid(),name:'East independent reviewer',branchId:String(east._id)};
 await User.create({_id:eastReviewer.id,name:eastReviewer.name,email:`${eastReviewer.id}@example.invalid`,passwordHash:'isolated-only',role:eastReviewer.role,branchId:eastReviewer.branchId,allowedModules:eastReviewer.allowedModules,mfaEnabledAt:new Date(),authVersion:0});
 async function eastAccount(kind,code,balance){
  const account=await treasury.createAccount(conn,tenant,owner,{kind,code,name:'East '+code,currency:'UGX',network:kind==='wallet'?'MTN':''},{configurationBranchId:String(east._id)});
  assert.equal(String(account.branchId),String(east._id));
  const response=await treasury.requestObservation(conn,tenant,owner,account._id,{kind:'opening',actualBalance:String(balance),observedAt:new Date(Date.now()-1000).toISOString(),evidenceType:kind==='wallet'?'provider_statement':'bank_statement',evidenceReference:'EAST-OPEN-'+code,note:'Actual East account setup evidence inspected by the tenant owner',idempotencyKey:crypto.randomUUID()});
  await treasury.reviewObservation(conn,tenant,eastReviewer,response.observation._id,{decision:'approve',note:'East branch reviewer independently checks the named statement'});return account;
 }
 const eastBank=await eastAccount('bank','EAST_BANK',100),eastWallet=await eastAccount('wallet','EAST_WALLET',0);
 const eastFunding=await funding.request(conn,tenant,owner,input(eastBank,eastWallet,50));assert.equal(String(eastFunding.funding.branchId),String(east._id));
 await funding.review(conn,tenant,eastReviewer,eastFunding.funding._id,{decision:'approve',note:'Independent East source and destination transfer evidence confirmed'});assert.equal(await balance(eastBank),'50');assert.equal(await balance(eastWallet),'50');
 assert.equal(String((await User.findById(owner.id)).branchId),String(branch._id),'configuration and funding never change the owner operating assignment');
 await assert.rejects(funding.request(conn,tenant,operator,input(eastBank,eastWallet,1)),error=>[403,404].includes(error.status));
 await assert.rejects(funding.request(conn,tenant,owner,input(bank,eastWallet,1)),{status:409});
 assert(!(await funding.list(conn,tenant,{...owner,viewBranchId:String(branch._id)})).some(row=>String(row.branchId)===String(east._id)));
 assert((await funding.list(conn,tenant,{...owner,viewBranchId:String(east._id)})).every(row=>String(row.branchId)===String(east._id)));
 assert((await funding.list(conn,tenant,{...owner,viewBranchId:'all'})).some(row=>String(row._id)===String(eastFunding.funding._id)));
 const ignoredBody=await treasury.createAccount(conn,tenant,owner,{kind:'bank',code:'BODY_BRANCH_IGNORED',name:'Server branch proof',currency:'UGX',isDefault:false,branchId:String(east._id)});assert.equal(String(ignoredBody.branchId),String(branch._id));
 // Owner may approve their own routine transfer in the same branch.
 // Reverse the test funding with a separate traceable transfer and prove
 // both books conserve their starting balances.
 const beforeOwn={bank:await balance(bank),wallet:await balance(wallet)};
 const ownMove=await funding.request(conn,tenant,owner,input(bank,wallet,1));
 assert.equal((await decide(ownMove.funding,owner)).funding.status,'posted');
 const ownReturn=await funding.request(conn,tenant,owner,input(wallet,bank,1));
 assert.equal((await decide(ownReturn.funding,owner)).funding.status,'posted');
 assert.deepEqual({bank:await balance(bank),wallet:await balance(wallet)},beforeOwn);
 assert.equal((await ledger.trialBalance(conn,{branchId:east._id,currency:'UGX'})).balanced,true);

 const operationCount=await core.mobileTransactionModel(conn).countDocuments();
 const financialCount=await core.financialOperationModel(conn).countDocuments();
 const addition=contribution(centsWallet,'7.35');
 await assert.rejects(funding.postDirect(conn,tenant,operator,addition),{status:400});
 await assert.rejects(funding.request(conn,tenant,operator,{...addition,sourceAccountId:String(bank._id)}),{status:400});
 await assert.rejects(funding.request(conn,tenant,operator,contribution(ignoredBody,'1')),{status:409});
 await assert.rejects(funding.request(conn,tenant,operator,contribution(otherWallet,'1')),{status:404});
 const added=(await funding.request(conn,tenant,operator,addition)).funding;
 assert.equal(added.status,'pending_review');
 assert.equal(await balance(centsWallet),'1025');
 const listed=(await funding.list(conn,tenant,operator,{accountId:centsWallet._id})).find(row=>String(row._id)===String(added._id));
 assert.equal(listed.sourceKind,'owner_contribution');
 assert.equal(listed.source,null);
 assert.equal(String(listed.destination._id),String(centsWallet._id));
 assert.equal((await funding.request(conn,tenant,operator,addition)).duplicate,true);
 await assert.rejects(funding.request(conn,tenant,operator,{...addition,amount:'7.36'}),{status:409});
 await assert.rejects(decide(added,operator),{status:403});
 await assert.rejects(decide(added,eastReviewer),{status:404});
 const ownerRequest=(await funding.request(conn,tenant,owner,contribution(centsBank,'1'))).funding;
 await assert.rejects(decide(ownerRequest,owner),{status:403});
 await decide(ownerRequest,reviewer,{decision:'reject'});
 const attributed=(await decide(added)).funding;
 assert.equal(attributed.status,'posted');
 assert.equal(await balance(centsWallet),'1760');
 assert.equal(await balance(centsBank),'11320');
 assert.equal((await decide(added)).duplicate,true);
 assert.equal((await funding.request(conn,tenant,operator,addition)).duplicate,true);
 const ownerEquity=await funds.models(conn).counter.findOne({branchId:branch._id,currency:'KES',purpose:'capital_contribution'});
 assert.equal((await core.ledgerAccountModel(conn).findById(ownerEquity.ledgerAccountId)).category,'equity');
 const lines=await core.ledgerPostingModel(conn).find({journalId:attributed.journalIds[0]}).lean();
 assert.deepEqual(lines.map(line=>[String(line.accountId),line.side,String(line.amountMinor)]).sort(),[
  [String(centsWallet.ledgerAccountId),'debit','735'],
  [String(ownerEquity.ledgerAccountId),'credit','735']
 ].sort());
 const actualCheck=await treasury.requestObservation(conn,tenant,operator,centsWallet._id,{
  kind:'checkpoint',actualBalance:'17.60',observedAt:new Date().toISOString(),evidenceType:'provider_statement',
  evidenceReference:addition.evidenceReference,note:'Owner contribution appears on the actual wallet statement',
  idempotencyKey:crypto.randomUUID()
 });
 const approvedCheck=await treasury.reviewObservation(conn,tenant,reviewer,actualCheck.observation._id,{
  decision:'approve',note:'Current statement matches the posted owner contribution'
 });
 assert.equal(String(approvedCheck.varianceMinorAtReview),'0');
 assert.equal(await balance(centsWallet),'1760','checking actual balance must not post the contribution again');

 const cashAddition=(await funding.request(conn,tenant,operator,contribution(drawer,'20'))).funding;
 await assert.rejects(cash.submit(conn,tenant,operator,shift._id,{countedCash:'420'}),error=>error.status===409&&/pending money/.test(error.message));
 await decide(cashAddition);
 assert.equal(await balance(drawer),'420');
 assert.equal(String((await core.cashSessionModel(conn).findById(shift._id)).provisionalMovementMinor),'-80');
 const closing=await cash.submit(conn,tenant,operator,shift._id,{countedCash:'420'});
 assert.equal(String(closing.expectedClosingMinor),'420');
 assert.equal(String(closing.varianceMinor),'0');
 await cash.decide(conn,tenant,reviewer,closing._id,{decision:'approve',note:'The final physical count includes the verified owner contribution'});
 const nextShift=await cash.open(conn,tenant,operator,{openingCash:'420'});
 await cash.decideOpening(conn,tenant,reviewer,nextShift._id,{decision:'approve',note:'The funds retained from the previous day were counted and confirmed'});
 assert.equal(await balance(drawer),'420','opening the next day preserves the retained balance');
 assert.equal(await core.mobileTransactionModel(conn).countDocuments(),operationCount);
 assert.equal(await core.financialOperationModel(conn).countDocuments(),financialCount);
 assert.equal((await ledger.trialBalance(conn,{branchId:branch._id,currency:'UGX'})).balanced,true);
 assert.equal((await ledger.trialBalance(conn,{branchId:branch._id,currency:'KES'})).balanced,true);
 const archive=await require('../src/tenant/backups/snapshot').capture(conn,tenant,{branchId:branch._id,scopeKey:`branch:${branch._id}`});
 const archivedContribution=archive.data.tables.fundingRequests.find(row=>row._id===String(added._id));
 assert.equal(archivedContribution.sourceKind,'owner_contribution');
 assert.equal(archivedContribution.evidenceReference,addition.evidenceReference);
 assert.equal(archivedContribution.status,'posted');
 assert.equal(archivedContribution.reviewedBy,reviewer.id);
 assert(archive.data.tables.fundBatches.some(row=>row._id===String(attributed.batchId)));
 assert(!archive.data.tables.fundingRequests.some(row=>row.branchId===String(east._id)));
 const reverseDirection={
  sourceAccountId:String(centsWallet._id),destinationAccountId:String(centsBank._id),
  amount:'17.60',idempotencyKey:crypto.randomUUID()
 };
 const returned=await funding.postDirect(conn,tenant,operator,reverseDirection);
 assert.equal(returned.funding.status,'posted');
 assert.equal(await balance(centsWallet),'0');
 assert.equal(await balance(centsBank),'13080');
 assert.equal((await funding.postDirect(conn,tenant,operator,reverseDirection)).duplicate,true);
 assert.equal(await balance(centsBank),'13080','the empty-source retry cannot post twice');
 console.log('PASS: Wallet transfers and owner contributions post exact balanced journals once, preserve account and reviewer scope, and roll back failed audit writes. Actual balance checks and the next cash day retain posted funds.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_wallet_funding_[a-f0-9]{14}$/.test(platformName)){if(conn)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('WALLET FUNDING INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Wallet funding cleanup failed:',error.message);process.exitCode=1;}));
