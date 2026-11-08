#!/usr/bin/env node
'use strict';
// Actual manual accounting in disposable loopback-only databases. No provider
// status is simulated: assertions distinguish posted manual books explicitly.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Funded integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),platformName=`cfh_funded_probe_${nonce}`,slugs=[`funded-a-${nonce}`,`funded-b-${nonce}`];
configured.pathname='/'+platformName;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const core=require('../src/tenant/models'),funded=require('../src/tenant/services/fundedOperations.service'),fundedModel=require('../src/tenant/funded/models');
const treasury=require('../src/tenant/treasury/service'),cash=require('../src/tenant/services/cashDrawer.service'),ledger=require('../src/tenant/services/ledger.service');
const directory=require('../src/tenant/customerAccounts/service'),directoryModels=require('../src/tenant/customerAccounts/models');
const banking=require('../src/tenant/services/banking.service'),forex=require('../src/tenant/services/forex.service'),transfer=require('../src/tenant/services/moneyTransfer.service');
const Tenant=require('../src/platform/models/Tenant'),Usage=require('../src/platform/models/UsageCounter'),{permissionsFor}=require('../src/config/roles');
const {models:treasuryModels}=require('../src/tenant/treasury/models');
let connections=[];
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),Usage.createIndexes(),require('../src/platform/models/LoginThrottle').createIndexes()]);
 connections=slugs.map(getTenantConnection);const [conn,other]=connections;
 await Promise.all(connections.map(core.ensureTenantIndexes));await funded.prepareIndexes(conn);await treasury.ensure(conn);
 const moduleKeys=require('../src/data/store').modules.filter(module=>['enabled','recording_only'].includes(module.runtimeStatus)&&module.key!=='sms_capture').map(module=>module.key);
 const terms={...require('../src/data/store').plans.find(plan=>plan.code==='enterprise'),code:'manual_funded',modules:moduleKeys};
 const commerce=require('../src/platform/services/commercial.service'),snapshot=commerce.planSnapshot({...commerce.asPlanVersion(terms),status:'published'});
 const tenant=await Tenant.create({name:'Manual funded probe',slug:slugs[0],dbName:conn.name,owner:'Scratch Owner',email:`funded-${nonce}@example.invalid`,plan:terms.code,status:'active',setupStatus:'complete',enabledModules:snapshot.modules,seatsReserved:3,branchCount:1,
  subscription:{...snapshot,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const owner={id:String(new mongoose.Types.ObjectId()),name:'Manual maker',role:'Tenant Owner',permissions:['*'],allowedModules:moduleKeys,authVersion:0};
 const reviewer={id:String(new mongoose.Types.ObjectId()),name:'Independent reviewer',role:'Reconciliation Officer',permissions:permissionsFor('Reconciliation Officer'),allowedModules:moduleKeys,authVersion:0};
 const auditor={id:String(new mongoose.Types.ObjectId()),name:'Auditor',role:'Auditor',permissions:permissionsFor('Auditor'),allowedModules:moduleKeys,authVersion:0};
 const branch=await core.branchModel(conn).create({name:'Counted branch',code:'counted',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
 for(const actor of [owner,reviewer,auditor]){actor.branchId=String(branch._id);await core.tenantUserModel(conn).create({_id:actor.id,name:actor.name,email:`${actor.id}@example.invalid`,passwordHash:'scratch-not-a-real-password',role:actor.role,branchId:actor.branchId,allowedModules:moduleKeys,status:'active',mfaEnabledAt:new Date(),authVersion:0});}
 const shift=await cash.open(conn,tenant,owner,{openingCash:'1000000'});await cash.decideOpening(conn,tenant,reviewer,shift._id,{decision:'approve',note:'Independent opening cash physically counted and checked'});
 async function opened(code,kind,currency,actualBalance){
  const account=await treasury.createAccount(conn,tenant,owner,{code,name:`Verified ${code}`,kind,currency,operatorId:kind==='cash'?owner.id:undefined,isDefault:true});
  const result=await treasury.requestObservation(conn,tenant,owner,account._id,{kind:'opening',actualBalance,observedAt:new Date(Date.now()-1000).toISOString(),evidenceType:({cash:'cash_count',forex_stock:'stock_count',transfer_clearing:'transfer_register',bank:'bank_statement'})[kind],evidenceReference:`OPEN-${code}-${nonce}`,note:'Original actual balance evidence independently counted and recorded',idempotencyKey:crypto.randomUUID()});
  await treasury.reviewObservation(conn,tenant,reviewer,result.observation._id,{decision:'approve',note:'Independent actual balance evidence checked against the opening declaration'});return treasuryModels(conn).account.findById(account._id).lean();
 }
 const cashFund=await opened('CASH_MAIN','cash','UGX','1000000'),stock=await opened('USD_STOCK','forex_stock','USD','1000.00'),clearing=await opened('TRANSFER_PAYABLE','transfer_clearing','UGX','0');
 const book=async account=>BigInt(String((await treasuryModels(conn).account.findById(account._id).lean()).bookBalanceMinor));
 const originalObserved=String((await treasuryModels(conn).account.findById(cashFund._id)).lastObservedMinor);
 const customer=(await directory.customerCreate(conn,tenant,owner,{name:'Actual customer',phone:'+256700123456',type:'Individual',idempotencyKey:crypto.randomUUID()})).record;
 const acct=async number=>(await directory.accountCreate(conn,tenant,owner,{customerId:String(customer._id),accountNumber:number,type:'Current Account',status:'active',risk:'Low',idempotencyKey:crypto.randomUUID()})).record;
 const accountA=await acct('FUNDED-A-'+nonce.toUpperCase()),accountB=await acct('FUNDED-B-'+nonce.toUpperCase());
 const customerBook=async account=>BigInt((await directory.accountDetail(conn,tenant,owner,account._id)).balance.minor);
 const requestData=extra=>({idempotencyKey:crypto.randomUUID(),evidenceReference:'COUNTED-VOUCHER-'+nonce,note:'Actual counted customer instruction checked against the original voucher',...extra});
 const reviewData={decision:'approve',note:'Independent source documents, amounts and actual fund accounts checked'};
 async function bankSource(kind,amount,destinationId){return (await banking.createRequest(conn,tenant,owner,{kind,sourceId:'account:'+accountA._id,...(destinationId?{destinationId:'account:'+destinationId}:{}),currency:'UGX',amount,note:'Customer manual account instruction supported by the original cash voucher',paymentChannel:'Cash',idempotencyKey:crypto.randomUUID()})).order;}
 async function manual(type,source,extra={}){const input=requestData(extra),result=await funded.request(conn,tenant,owner,type,source._id,input);return {...result,input};}
 const depositSource=await bankSource('deposit_request','10000'),deposit=await manual('banking',depositSource,{cashAccountId:String(cashFund._id)});
 assert.equal(await book(cashFund),1000000n);assert.equal(await customerBook(accountA),0n,'a pending instruction cannot create customer funds');
 assert((await funded.request(conn,tenant,owner,'banking',depositSource._id,deposit.input)).duplicate);
 await assert.rejects(funded.request(conn,tenant,owner,'banking',depositSource._id,{...deposit.input,note:'Changed accounting instructions must never reuse an idempotency key'}),{status:409});
 await assert.rejects(funded.review(conn,tenant,owner,deposit.execution._id,reviewData),{status:403});
 await assert.rejects(funded.detail(other,tenant,owner,deposit.execution._id),{status:403});
 const concurrent=await Promise.allSettled([funded.review(conn,tenant,reviewer,deposit.execution._id,reviewData),funded.review(conn,tenant,reviewer,deposit.execution._id,reviewData)]);
 assert.equal(concurrent.filter(row=>row.status==='fulfilled').length,1);assert.equal(concurrent.filter(row=>row.status==='rejected'&&row.reason.status===409).length,1);
 assert.equal(await book(cashFund),1010000n);assert.equal(await customerBook(accountA),10000n);assert.equal((await core.bankingRequestModel(conn).findById(depositSource._id)).status,'posted_manual');
 const withdrawalSource=await bankSource('withdrawal_request','3000'),withdrawal=await manual('banking',withdrawalSource,{cashAccountId:String(cashFund._id)});await funded.review(conn,tenant,reviewer,withdrawal.execution._id,reviewData);
 assert.equal(await book(cashFund),1007000n);assert.equal(await customerBook(accountA),7000n);
 const internalSource=await bankSource('transfer_request','2000',accountB._id),internal=await manual('banking',internalSource);await funded.review(conn,tenant,reviewer,internal.execution._id,reviewData);
 assert.equal(await book(cashFund),1007000n);assert.equal(await customerBook(accountA),5000n);assert.equal(await customerBook(accountB),2000n);
 const beforeDeniedJournals=await core.ledgerJournalModel(conn).countDocuments(),tooLargeSource=await bankSource('withdrawal_request','6000'),tooLarge=await manual('banking',tooLargeSource,{cashAccountId:String(cashFund._id)});
 await assert.rejects(funded.review(conn,tenant,reviewer,tooLarge.execution._id,reviewData),error=>error.status===409&&/Insufficient posted customer/.test(error.message));
 assert.equal(await core.ledgerJournalModel(conn).countDocuments(),beforeDeniedJournals);assert.equal(await book(cashFund),1007000n);await funded.review(conn,tenant,reviewer,tooLarge.execution._id,{decision:'reject',note:'Rejected because the customer posted funds cannot support this withdrawal'});
 const proposedRate=await forex.proposeRate(conn,tenant,owner,{fromCurrency:'USD',toCurrency:'UGX',rateDecimal:'3700',validHours:24,note:'Actual approved indicative rate board for manual customer exchange'}),rate=await forex.decideRate(conn,tenant,reviewer,proposedRate._id,reviewData);
 async function quote(operation,amount,commission){return (await forex.createQuote(conn,tenant,owner,{operation,rateId:String(rate._id),customerLabel:'Actual customer',customerPhone:'+256700123456',amount,commission,note:'Customer agreed to the displayed manual exchange terms and counted notes',settlementMethod:'Cash',idempotencyKey:crypto.randomUUID()})).quote;}
 const buySource=await quote('buy','10','100'),buy=await manual('forex',buySource,{foreignAccountId:String(stock._id),settlementAccountId:String(cashFund._id)});await funded.review(conn,tenant,reviewer,buy.execution._id,reviewData);
 assert.equal(await book(stock),101000n);assert.equal(await book(cashFund),970100n);
 const sellSource=await quote('sell','5','50'),sell=await manual('forex',sellSource,{foreignAccountId:String(stock._id),settlementAccountId:String(cashFund._id)});await funded.review(conn,tenant,reviewer,sell.execution._id,reviewData);
 assert.equal(await book(stock),100500n);assert.equal(await book(cashFund),988650n);
 const overStockSource=await quote('sell','2000','0'),overStock=await manual('forex',overStockSource,{foreignAccountId:String(stock._id),settlementAccountId:String(cashFund._id)}),stockBefore=await book(stock),cashBefore=await book(cashFund),journalsBefore=await core.ledgerJournalModel(conn).countDocuments();
 await assert.rejects(funded.review(conn,tenant,reviewer,overStock.execution._id,reviewData),error=>error.status===409&&/Insufficient/.test(error.message));assert.equal(await book(stock),stockBefore);assert.equal(await book(cashFund),cashBefore);assert.equal(await core.ledgerJournalModel(conn).countDocuments(),journalsBefore);
 await funded.review(conn,tenant,reviewer,overStock.execution._id,{decision:'reject',note:'Original foreign notes were insufficient for the proposed customer sale'});
 const sender=await transfer.addContact(conn,tenant,owner,{kind:'sender',fullName:'Verified sender',phone:'+256700111222',country:'UG'}),receiver=await transfer.addContact(conn,tenant,owner,{kind:'beneficiary',fullName:'Verified receiver',phone:'+256700123456',country:'UG'});
 const transferSource=(await transfer.createRequest(conn,tenant,owner,{senderId:String(sender._id),beneficiaryId:String(receiver._id),amount:'20000',fee:'200',currency:'UGX',transferMethod:'Cash',idempotencyKey:crypto.randomUUID()})).order;
 const collection=await manual('money_transfer',transferSource,{collectionAccountId:String(cashFund._id),clearingAccountId:String(clearing._id)});await funded.review(conn,tenant,reviewer,collection.execution._id,reviewData);
 assert.equal(await book(cashFund),1008850n);assert.equal(await book(clearing),20000n);assert.equal((await core.transferOrderModel(conn).findById(transferSource._id)).status,'collected_manual');
 const revealed=await funded.revealPin(conn,tenant,owner,collection.execution._id);assert.match(revealed.pin,/^\d{6}$/);await assert.rejects(funded.revealPin(conn,tenant,owner,collection.execution._id),{status:409});await assert.rejects(funded.revealPin(conn,tenant,auditor,collection.execution._id),{status:403});
 const normalRead=await fundedModel.models(conn).execution.findById(collection.execution._id).lean();assert.equal(normalRead.pinHash,undefined);assert.equal(normalRead.pinEncrypted,undefined);assert.equal((await funded.detail(conn,tenant,auditor,collection.execution._id)).canRevealPin,false);
 await assert.rejects(funded.checkPayout(conn,tenant,owner,{pin:revealed.pin,senderPhone:'+256700999999',receiverNameCheck:'Verified receiver'}),{status:404});
 const checked=await funded.checkPayout(conn,tenant,owner,{pin:revealed.pin,senderPhone:'+256700111222',receiverNameCheck:'Verified receiver',identityDocument:'RECEIVER-PASSPORT'});
 const payoutInput=requestData({verificationToken:checked.token,payoutAccountId:String(cashFund._id)}),payout=await funded.requestPayout(conn,tenant,owner,payoutInput);
 assert.equal(await book(cashFund),1008850n,'matching the PIN and submitting payout cannot release cash before independent review');assert((await funded.requestPayout(conn,tenant,owner,payoutInput)).duplicate);
 await assert.rejects(funded.requestPayout(conn,tenant,owner,{...payoutInput,verificationToken:crypto.randomBytes(32).toString('hex')}),{status:409});
 await assert.rejects(funded.requestPayout(conn,tenant,owner,{...payoutInput,idempotencyKey:crypto.randomUUID()}),{status:409},'verification is consumed once');
 await funded.review(conn,tenant,reviewer,payout.execution._id,reviewData);assert.equal(await book(cashFund),988850n);assert.equal(await book(clearing),0n);assert.equal((await core.transferOrderModel(conn).findById(transferSource._id)).status,'paid_out_manual');
 await assert.rejects(funded.review(conn,tenant,reviewer,payout.execution._id,reviewData),{status:409});await assert.rejects(funded.checkPayout(conn,tenant,owner,{pin:revealed.pin,senderPhone:'+256700111222'}),{status:404});
 for(let i=0;i<10;i++)await assert.rejects(funded.checkPayout(conn,tenant,owner,{pin:'123456',senderPhone:'+256700199999'}),{status:404});
 await assert.rejects(funded.checkPayout(conn,tenant,owner,{pin:'123456',senderPhone:'+256700199999'}),{status:429},'same phone and branch guesses are limited across database-backed attempts');
 const expiredChecked=await treasuryModels(conn).account.findById(cashFund._id).lean();assert.equal(String(expiredChecked.lastObservedMinor),originalObserved,'expected book movement cannot pretend the last external/counted observation changed live');
 const disabledSource=await bankSource('deposit_request','100'),disabled=await manual('banking',disabledSource,{cashAccountId:String(cashFund._id)});
 await core.tenantUserModel(conn).updateOne({_id:owner.id},{$set:{status:'disabled'},$inc:{authVersion:1}});const disabledBefore=await book(cashFund);await assert.rejects(funded.review(conn,tenant,reviewer,disabled.execution._id,reviewData),{status:403});assert.equal(await book(cashFund),disabledBefore);
 await core.tenantUserModel(conn).updateOne({_id:owner.id},{$set:{status:'active'}});owner.authVersion=1;await funded.review(conn,tenant,reviewer,disabled.execution._id,{decision:'reject',note:'Originator access changed before the manual movement could be posted'});
 for(const account of [cashFund,stock,clearing])await treasury.assertBookIntegrity(conn,null,await treasuryModels(conn).account.findById(account._id).lean());
 for(const currency of ['UGX','USD'])assert.equal((await ledger.trialBalance(conn,{branchId:String(branch._id),currency})).balanced,true);
 for(const journal of await core.ledgerJournalModel(conn).find({}).select('_id').lean())assert.equal((await ledger.inspectJournal(conn,journal._id)).valid,true);
 const closing=await core.cashSessionModel(conn).findById(shift._id).lean();assert.equal(BigInt(String(closing.openingMinor))+BigInt(String(closing.provisionalMovementMinor)),await book(cashFund));
 await cash.submit(conn,tenant,owner,shift._id,{countedCash:String(await book(cashFund)),note:'Physical drawer count agrees with all independently posted manual module movements'});await cash.decide(conn,tenant,reviewer,shift._id,{decision:'approve',note:'Independent multi-module cash closing count matches the treasury book'});
 assert.equal((await core.cashSessionModel(conn).findById(shift._id)).status,'approved');
 // Every cash-handling module owns its own actual independently verified
 // drawer. An operator dashboard must never expose the branch-wide cash total.
 const workspace=require('../src/tenant/services/workspaceSnapshot.service');
 const emptyOverview={hasMobileMoney:false,hasTransfer:false,hasBanking:false,hasForex:false};
 const operatorDrawers=[];
 for(const [role,moduleKey,opening] of [['Banking Operator','banking','10000'],['Forex Operator','forex','20000'],['Money Transfer Operator','money_transfer','30000'],['Mobile Money Operator','mobile_money','40000']]){
  const actor={id:String(new mongoose.Types.ObjectId()),name:role,role,permissions:permissionsFor(role),allowedModules:[moduleKey],branchId:String(branch._id),authVersion:0};
  await core.tenantUserModel(conn).create({_id:actor.id,name:actor.name,email:`${actor.id}@example.invalid`,passwordHash:'scratch-not-a-real-password',role,branchId:actor.branchId,allowedModules:[moduleKey],status:'active',authVersion:0});
  const ownShift=await cash.open(conn,tenant,actor,{openingCash:opening});await cash.decideOpening(conn,tenant,reviewer,ownShift._id,{decision:'approve',note:'Independent physical count for the separately assigned module operator drawer'});
  operatorDrawers.push({actor,ownShift,opening});
 }
 for(const {actor,ownShift,opening} of operatorDrawers){
  const actual=await workspace.snapshot(conn,tenant,actor,emptyOverview,branch);
  assert.equal(actual.cash.length,1,actor.role);assert.equal(actual.cash[0].shiftCount,1,actor.role+' must see only its own drawer');
  assert.equal(actual.cash[0].expectedFormatted,require('../src/tenant/services/mobileMoney.service').formatMoneyMinor(opening,'UGX'));
  assert.equal(actual.currentCashShift.id,String(ownShift._id));assert.equal(actual.currentCashShift.href,`/tenant/cash/shifts/${ownShift._id}`);assert.equal(actual.currentCashShift.submitAction,`/tenant/cash/shifts/${ownShift._id}/submit`);assert.equal(actual.dayStatus,'OPEN');
  for(const denied of [{...actor,permissions:actor.permissions.filter(permission=>permission!=='treasury.view')},{...actor,allowedModules:[]},{...actor,role:'Viewer',permissions:['*']}]){
   const hidden=await workspace.snapshot(conn,tenant,denied,emptyOverview,branch);assert.deepEqual(hidden.cash,[]);assert.equal(hidden.currentCashShift,null);assert.equal(hidden.dayStatus,null);
  }
  const foreign=await workspace.snapshot(conn,tenant,actor,emptyOverview,{...branch.toObject(),_id:new mongoose.Types.ObjectId()});assert.deepEqual(foreign.cash,[]);assert.equal(foreign.currentCashShift,null);
 }
 const branchCash=await workspace.snapshot(conn,tenant,reviewer,emptyOverview,branch);assert.equal(branchCash.cash[0].shiftCount,4);assert.equal(branchCash.cash[0].expectedFormatted,'UGX 100,000');
 const pendingActor={...operatorDrawers[0].actor,id:String(new mongoose.Types.ObjectId())};
 await core.tenantUserModel(conn).create({_id:pendingActor.id,name:'Pending operator',email:`${pendingActor.id}@example.invalid`,passwordHash:'scratch-not-a-real-password',role:pendingActor.role,branchId:pendingActor.branchId,allowedModules:pendingActor.allowedModules,status:'active',authVersion:0});
 await cash.open(conn,tenant,pendingActor,{openingCash:'5000'});
 const pendingSnapshot=await workspace.snapshot(conn,tenant,pendingActor,emptyOverview,branch);assert.deepEqual(pendingSnapshot.cash,[]);assert.equal(pendingSnapshot.currentCashShift,null);assert.equal(pendingSnapshot.dayStatus,'PENDING');
 const logs=JSON.stringify(await core.auditEventModel(conn).find({}).lean());assert(!logs.includes(revealed.pin),'audit must never contain payout PIN');
 console.log('PASS: actual manual banking deposits/withdrawals/internal transfers, customer liability balances, FX stock/settlement/explicit fees, transfer collection/payable/PIN once-only verification/payout, maker-checker, cash closing, ledger integrity, concurrency/idempotency, insufficient-fund rollback, privacy, revocation and role-scoped cash dashboard snapshots across all four operator modules.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_funded_probe_[a-f0-9]{16}$/.test(platformName)){for(const connection of connections)await connection.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('FUNDED OPERATIONS INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Funded scratch cleanup failed:',error.message);process.exitCode=1;}));
