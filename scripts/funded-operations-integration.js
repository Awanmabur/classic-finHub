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
// Only after the strict loopback/no-credentials guard above: use unique,
// disposable keys for this isolated financial integration. Never inherit or
// persist real production encryption keys, and never send external SMS.
process.env.MFA_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');
process.env.TRANSFER_SMS_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');
process.env.TRANSFER_SMS_PROVIDER='none';
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
 for(const connection of connections)await core.ensureTenantIndexes(connection);await funded.prepareIndexes(conn);await treasury.ensure(conn);
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
 async function bankSource(kind,amount,destinationId){return (await banking.createRequest(conn,tenant,owner,{kind,sourceId:'account:'+accountA._id,...(destinationId?{destinationId:'account:'+destinationId}:{}),currency:'UGX',amount,note:'Customer manual account instruction supported by the original cash voucher',paymentChannel:kind==='transfer_request'?'Internal transfer':'Cash',idempotencyKey:crypto.randomUUID()})).order;}
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
 const historicalBalances=require('../src/tenant/services/recordBalances.service');
 const depositHistory=await historicalBalances.forRecord(conn,tenant,owner,'banking',
  await core.bankingRequestModel(conn).findById(depositSource._id).lean());
 assert(depositHistory.some(row=>row.kind==='cash'&&row.currency==='UGX'&&row.balanceAfter==='UGX 1,010,000'),
  'Banking detail must show original posted cash after this specific deposit');
 const withdrawalSource=await bankSource('withdrawal_request','3000'),withdrawal=await manual('banking',withdrawalSource,{cashAccountId:String(cashFund._id)});await funded.review(conn,tenant,reviewer,withdrawal.execution._id,reviewData);
 assert.equal(await book(cashFund),1007000n);assert.equal(await customerBook(accountA),7000n);
 const internalSource=await bankSource('transfer_request','2000',accountB._id),internal=await manual('banking',internalSource);await funded.review(conn,tenant,reviewer,internal.execution._id,reviewData);
 assert.equal(await book(cashFund),1007000n);assert.equal(await customerBook(accountA),5000n);assert.equal(await customerBook(accountB),2000n);
 const beforeDeniedJournals=await core.ledgerJournalModel(conn).countDocuments(),tooLargeSource=await bankSource('withdrawal_request','6000'),tooLarge=await manual('banking',tooLargeSource,{cashAccountId:String(cashFund._id)});
 await assert.rejects(funded.review(conn,tenant,reviewer,tooLarge.execution._id,reviewData),error=>error.status===409&&/Insufficient posted customer/.test(error.message));
 assert.equal(await core.ledgerJournalModel(conn).countDocuments(),beforeDeniedJournals);assert.equal(await book(cashFund),1007000n);await funded.review(conn,tenant,reviewer,tooLarge.execution._id,{decision:'reject',note:'Rejected because the customer posted funds cannot support this withdrawal'});
 const proposedRate=await forex.proposeRate(conn,tenant,owner,{fromCurrency:'USD',toCurrency:'UGX',side:'buy',rateDecimal:'3700',validHours:24,note:'Actual approved indicative rate board for manual customer exchange'}),rate=await forex.decideRate(conn,tenant,reviewer,proposedRate._id,reviewData);
 const proposedSellRate=await forex.proposeRate(conn,tenant,owner,{fromCurrency:'USD',toCurrency:'UGX',side:'sell',rateDecimal:'3700.01',validHours:24,note:'Separately approved customer USD selling price for manual settlement'});
 const sellRate=await forex.decideRate(conn,tenant,reviewer,proposedSellRate._id,reviewData);
 async function quote(operation,amount,commission,originModule='forex',originRecordId=null){return (await forex.createQuote(conn,tenant,owner,{operation,originModule,originRecordId,rateId:String(operation==='sell'?sellRate._id:rate._id),customerLabel:'Actual customer',customerPhone:'+256700123456',amount,commission,note:'Customer agreed to the displayed manual exchange terms and counted notes',settlementMethod:'Cash',idempotencyKey:crypto.randomUUID()})).quote;}
 const buySource=await quote('buy','10','0'),buy=await manual('forex',buySource,{foreignAccountId:String(stock._id),settlementAccountId:String(cashFund._id)});
 await assert.rejects(funded.finalizeForex(conn,tenant,owner,buy.execution._id,{confirmFundsExchanged:'yes'}),{status:403},'missing receipt evidence confirmation cannot post');
 assert.equal((await funded.finalizeForex(conn,tenant,owner,buy.execution._id,{confirmFundsExchanged:'yes',confirmEvidenceChecked:'yes'})).execution.status,'posted_manual');
 assert((await funded.finalizeForex(conn,tenant,owner,buy.execution._id,{})).duplicate,'retry cannot post duplicate movement');
 assert.equal(await book(stock),101000n);assert.equal(await book(cashFund),970000n);
 const boughtHistory=await historicalBalances.forRecord(conn,tenant,owner,'forex',
  await core.forexQuoteModel(conn).findById(buySource._id).lean());
 assert(boughtHistory.some(row=>row.currency==='USD'&&row.balanceAfter==='USD 1,010.00'),
  'Forex source stock has exact original after-balance');
 assert(boughtHistory.some(row=>row.currency==='UGX'&&row.balanceAfter==='UGX 970,000'),
  'Forex settlement drawer has exact original after-balance');
 const sellSource=await quote('sell','5','0'),sell=await manual('forex',sellSource,{foreignAccountId:String(stock._id),settlementAccountId:String(cashFund._id)});
 await funded.finalizeForex(conn,tenant,owner,sell.execution._id,{confirmFundsExchanged:'yes',confirmEvidenceChecked:'yes'});
 assert.equal((await fundedModel.models(conn).execution.findById(sell.execution._id)).reviewedBy,null,'cashier confirmation must never claim independent review');
 assert.equal(await book(stock),100500n);assert.equal(await book(cashFund),988500n);
 const originReports=require('../src/tenant/services/financeOverview.service');
 assert.equal((await originReports.postedOriginFxActivity(conn,tenant,owner,branch,{moduleKey:'banking',timeZone:'Africa/Juba'})).count,0,
  'standalone Forex trades cannot be misattributed to Banking');
 assert.equal((await originReports.postedOriginFxActivity(conn,tenant,owner,branch,{moduleKey:'money_transfer',timeZone:'Africa/Juba'})).count,0,
  'standalone Forex trades cannot be misattributed to Money Transfer');
 const overStockSource=await quote('sell','2000','0'),overStock=await manual('forex',overStockSource,{foreignAccountId:String(stock._id),settlementAccountId:String(cashFund._id)}),stockBefore=await book(stock),cashBefore=await book(cashFund),journalsBefore=await core.ledgerJournalModel(conn).countDocuments();
 await assert.rejects(funded.finalizeForex(conn,tenant,owner,overStock.execution._id,{confirmFundsExchanged:'yes',confirmEvidenceChecked:'yes'}),error=>error.status===409&&/Insufficient/.test(error.message));assert.equal(await book(stock),stockBefore);assert.equal(await book(cashFund),cashBefore);assert.equal(await core.ledgerJournalModel(conn).countDocuments(),journalsBefore);
 await funded.review(conn,tenant,reviewer,overStock.execution._id,{decision:'reject',note:'Original foreign notes were insufficient for the proposed customer sale'});
 const sender=await transfer.addContact(conn,tenant,owner,{kind:'sender',fullName:'Verified sender',phone:'+256700111222',country:'UG'}),receiver=await transfer.addContact(conn,tenant,owner,{kind:'beneficiary',fullName:'Verified receiver',phone:'+256700123456',country:'UG'});
 // Persisted pre-branch-routing requests remain payable at their original
 // branch. Seed that historical shape explicitly; new service requests must
 // choose a different receiving branch (covered in branch-transfer integration).
 const transferSource=await core.transferOrderModel(conn).create({reference:`TR-LEGACY-${nonce.toUpperCase()}`,idempotencyKey:crypto.randomUUID(),branchId:branch._id,createdBy:owner.id,partyEntryMode:'saved_contact',
  sender:{contactId:sender._id,name:sender.fullName,phone:sender.phone,country:sender.country},beneficiary:{contactId:receiver._id,name:receiver.fullName,phone:receiver.phone,country:receiver.country},
  capture:require('../src/tenant/services/operationCapture.service').parse('money_transfer',{transferMethod:'Cash'}),currency:'UGX',amountMinor:'20000',feeMinor:'200',validDays:7,expiresAt:new Date(Date.now()+7*86400000),status:'requested'});
 await assert.rejects(quote('sell','5','0','money_transfer',String(transferSource._id)),
  error=>error.status===409&&/Money Transfer payout/.test(error.message),
  'No transfer, collected or uncollected, may be converted outside the PIN-verified remittance posting path');
 const collection=await manual('money_transfer',transferSource,{collectionAccountId:String(cashFund._id),clearingAccountId:String(clearing._id)});await funded.review(conn,tenant,reviewer,collection.execution._id,reviewData);
 assert.equal(await book(cashFund),1008700n);assert.equal(await book(clearing),20000n);assert.equal((await core.transferOrderModel(conn).findById(transferSource._id)).status,'collected_manual');
 await assert.rejects(quote('buy','2','0','banking',String(depositSource._id)),
  {status:409},'banking trades must use internal account currency conversion, not unlinked manual Forex');
 await assert.rejects(quote('sell','5','0','money_transfer',String(transferSource._id)),
  {status:409},'remittance FX is allowed only inside the actual verified payout process');
 const revealed=await funded.revealPin(conn,tenant,owner,collection.execution._id);assert.match(revealed.pin,/^\d{6}$/);await assert.rejects(funded.revealPin(conn,tenant,owner,collection.execution._id),{status:409});await assert.rejects(funded.revealPin(conn,tenant,auditor,collection.execution._id),{status:403});
 const normalRead=await fundedModel.models(conn).execution.findById(collection.execution._id).lean();assert.equal(normalRead.pinLookupVersion,'sender_v2','historical null-destination requests keep original-branch PIN verification');assert.equal(normalRead.pinHash,undefined);assert.equal(normalRead.pinEncrypted,undefined);assert.equal((await funded.detail(conn,tenant,auditor,collection.execution._id)).canRevealPin,false);
 await assert.rejects(funded.checkPayout(conn,tenant,owner,{pin:revealed.pin,senderPhone:'+256700999999',receiverNameCheck:'Verified receiver'}),{status:404});
 const checked=await funded.checkPayout(conn,tenant,owner,{pin:revealed.pin,senderPhone:'+256700111222',receiverNameCheck:'Verified receiver',identityDocument:'RECEIVER-PASSPORT'});
 const payoutInput=requestData({verificationToken:checked.token,payoutAccountId:String(cashFund._id)}),payout=await funded.requestPayout(conn,tenant,owner,payoutInput);
 assert.equal(await book(cashFund),1008700n,'matching the PIN and submitting payout cannot release cash before independent review');assert((await funded.requestPayout(conn,tenant,owner,payoutInput)).duplicate);
 await assert.rejects(funded.requestPayout(conn,tenant,owner,{...payoutInput,verificationToken:crypto.randomBytes(32).toString('hex')}),{status:409});
 await assert.rejects(funded.requestPayout(conn,tenant,owner,{...payoutInput,idempotencyKey:crypto.randomUUID()}),{status:409},'verification is consumed once');
 await funded.review(conn,tenant,reviewer,payout.execution._id,reviewData);assert.equal(await book(cashFund),988700n);assert.equal(await book(clearing),0n);assert.equal((await core.transferOrderModel(conn).findById(transferSource._id)).status,'paid_out_manual');
 const payoutHistory=await historicalBalances.forRecord(conn,tenant,owner,'money_transfer',
  await core.transferOrderModel(conn).findById(transferSource._id).lean());
 assert(payoutHistory.some(row=>row.currency==='UGX'&&row.balanceAfter==='UGX 988,700'),
  'Transfer record shows actual post-payout cash balance without displaying a pending request as paid');
 await assert.rejects(funded.review(conn,tenant,reviewer,payout.execution._id,reviewData),{status:409});await assert.rejects(funded.checkPayout(conn,tenant,owner,{pin:revealed.pin,senderPhone:'+256700111222'}),{status:404});
 for(let i=0;i<10;i++)await assert.rejects(funded.checkPayout(conn,tenant,owner,{pin:'123456',senderPhone:'+256700199999'}),{status:404});
 await assert.rejects(funded.checkPayout(conn,tenant,owner,{pin:'123456',senderPhone:'+256700199999'}),{status:429},'same phone and branch guesses are limited across database-backed attempts');
 // Same-branch cash pickup remittance: collect UGX, pay SSP at an approved
 // locked rate. No provider transfer is simulated or treated as completed.
 const ugxSspRateProposal=await forex.proposeRate(conn,tenant,owner,{
  fromCurrency:'UGX',toCurrency:'SSP',side:'buy',rateDecimal:'1.2',validHours:24,
  note:'Independently checked cash-remittance exchange rate for genuine UGX to SSP payout'});
 const ugxSspRate=await forex.decideRate(conn,tenant,reviewer,ugxSspRateProposal._id,reviewData);
 const sspShift=await cash.open(conn,tenant,owner,{currency:'SSP',openingCash:'20000'});
 await cash.decideOpening(conn,tenant,reviewer,sspShift._id,{
  decision:'approve',note:'Independently counted physical SSP cash before native-currency remittance payout'});
 const sspCash=await opened('CASH_SSP','cash','SSP','20000');
 const fxTransferSource=await core.transferOrderModel(conn).create({
  reference:'TR-FX-'+nonce.toUpperCase(),idempotencyKey:crypto.randomUUID(),branchId:branch._id,
  createdBy:owner.id,partyEntryMode:'saved_contact',
  sender:{contactId:sender._id,name:sender.fullName,phone:sender.phone,country:sender.country},
  beneficiary:{contactId:receiver._id,name:receiver.fullName,phone:receiver.phone,country:receiver.country},
  capture:require('../src/tenant/services/operationCapture.service').parse('money_transfer',{transferMethod:'Cash'}),
  currency:'UGX',amountMinor:'10000',feeMinor:'0',validDays:7,
  expiresAt:new Date(Date.now()+7*86400000),status:'requested'
 });
 const fxCollection=await manual('money_transfer',fxTransferSource,{
  collectionAccountId:String(cashFund._id),clearingAccountId:String(clearing._id)});
 await funded.review(conn,tenant,reviewer,fxCollection.execution._id,reviewData);
 const fxPin=await funded.revealPin(conn,tenant,owner,fxCollection.execution._id);
 const fxMatched=await funded.checkPayout(conn,tenant,owner,{
  pin:fxPin.pin,senderPhone:'+256700111222',receiverNameCheck:'Verified receiver',
  identityDocument:'RECEIVER-IDENTITY-SSP'
 });
 const fxPayoutCtx=await funded.payoutContext(conn,tenant,owner,fxMatched);
 assert(fxPayoutCtx.fxRates.some(r=>String(r._id)===String(ugxSspRate._id)));
 assert(fxPayoutCtx.payoutAccounts.some(a=>String(a._id)===String(sspCash._id)));
 const sspBefore=await book(sspCash),clearingBefore=await book(clearing);
 assert.equal(clearingBefore,10000n);
 const fxPayout=await funded.requestPayout(conn,tenant,owner,requestData({
  verificationToken:fxMatched.token,payoutAccountId:String(sspCash._id),
  rateChoice:String(ugxSspRate._id)+':'+ugxSspRate.revision+':'+ugxSspRate.rateDecimal
 }));
 assert.equal(fxPayout.sameBranch,true);
 assert.equal(String(fxPayout.execution.payoutFx.targetCurrency),'SSP');
 assert.equal(String(fxPayout.execution.payoutFx.payoutMinor),'1200000');
 assert.equal(await book(sspCash),sspBefore,'creating a payout request cannot release SSP funds');
 await assert.rejects(funded.finalizePayout(conn,tenant,owner,fxPayout.execution._id,{
  confirmRecipientVerified:'yes'}),{status:403},'a payout without physical handover confirmation cannot post');
 assert.equal(await book(sspCash),sspBefore);
 assert.equal((await funded.finalizePayout(conn,tenant,owner,fxPayout.execution._id,{
  confirmRecipientVerified:'yes',confirmCashPaid:'yes'})).execution.status,'posted_manual');
 assert((await funded.finalizePayout(conn,tenant,owner,fxPayout.execution._id,{})).duplicate,
  'cashier retries cannot cause duplicate SSP cash payouts');
 assert.equal((await core.transferOrderModel(conn).findById(fxTransferSource._id)).status,'paid_out_manual');
 assert.equal(await book(clearing),0n);
 assert.equal(await book(sspCash),sspBefore-1200000n);
 const fxPayoutJournal=await fundedModel.models(conn).execution.findById(fxPayout.execution._id).lean();
 assert.equal(fxPayoutJournal.journalIds.length,2,'real remittance conversion must post one balanced journal per currency');
 const actualTransfers=await require('../src/tenant/services/financeOverview.service').postedTransferPayoutFxActivity(
  conn,tenant,owner,branch,{moduleKey:'money_transfer',timeZone:'Africa/Juba'});
 assert.equal(actualTransfers.count,1);
 assert.equal(actualTransfers.sent[0].formatted,'UGX 10,000');
 assert.equal(actualTransfers.received[0].formatted,'SSP 12,000.00');
 await assert.rejects(funded.review(conn,tenant,reviewer,fxPayout.execution._id,reviewData),{status:409});
 await treasury.assertBookIntegrity(conn,null,await treasuryModels(conn).account.findById(sspCash._id).lean());
 for(const currency of ['UGX','SSP'])
  assert.equal((await ledger.trialBalance(conn,{branchId:String(branch._id),currency})).balanced,true);
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
 const branchCash=await workspace.snapshot(conn,tenant,reviewer,emptyOverview,branch);const ugxCash=branchCash.cash.find(row=>row.currency==='UGX');
 assert(ugxCash,'reviewer must see actual UGX currency cash independently');
 assert.equal(ugxCash.shiftCount,4);
 assert.equal(ugxCash.expectedFormatted,'UGX 100,000');
 assert(branchCash.cash.some(row=>row.currency==='SSP'),'reviewer must see SSP cash separately rather than merging currencies');
 const pendingActor={...operatorDrawers[0].actor,id:String(new mongoose.Types.ObjectId())};
 await core.tenantUserModel(conn).create({_id:pendingActor.id,name:'Pending operator',email:`${pendingActor.id}@example.invalid`,passwordHash:'scratch-not-a-real-password',role:pendingActor.role,branchId:pendingActor.branchId,allowedModules:pendingActor.allowedModules,status:'active',authVersion:0});
 await cash.open(conn,tenant,pendingActor,{openingCash:'5000'});
 const pendingSnapshot=await workspace.snapshot(conn,tenant,pendingActor,emptyOverview,branch);assert.deepEqual(pendingSnapshot.cash,[]);assert.equal(pendingSnapshot.currentCashShift,null);assert.equal(pendingSnapshot.dayStatus,'PENDING');
 const bankFx=require('../src/tenant/services/bankingInternalFx.service');
 const usdAccount=(await directory.accountCreate(conn,tenant,owner,{
  customerId:String(customer._id),accountNumber:'FUNDED-USD-'+nonce.toUpperCase(),
  currency:'USD',type:'Current Account',status:'active',risk:'Low',idempotencyKey:crypto.randomUUID()
 })).record;
 const ugxUsdProposal=await forex.proposeRate(conn,tenant,owner,{fromCurrency:'UGX',toCurrency:'USD',
  side:'buy',rateDecimal:'0.00027',validHours:24,note:'Exact rate for real internal customer account currency exchange'});
 const ugxUsdRate=await forex.decideRate(conn,tenant,reviewer,ugxUsdProposal._id,reviewData);
 const fxBankInput={sourceAccountId:String(accountA._id),destinationAccountId:String(usdAccount._id),
  rateId:String(ugxUsdRate._id),rateVersion:String(ugxUsdRate.revision),rateDecimal:ugxUsdRate.rateDecimal,
  amount:'2000',evidenceReference:'BANKFX-CLIENT-'+nonce,confirmCustomerAuthority:'yes',
  idempotencyKey:crypto.randomUUID()};
 assert.equal(await customerBook(accountA),5000n);
 assert.equal(await customerBook(usdAccount),0n);
 const bankFxPreview=await bankFx.preview(conn,tenant,owner,branch,fxBankInput);
 assert.equal(bankFxPreview.sourceLabel,'UGX 2,000');
 assert.equal(bankFxPreview.destinationLabel,'USD 0.54');
 const anotherCustomer=(await directory.customerCreate(conn,tenant,owner,{
  name:'Second customer',phone:'+256700555111',type:'Individual',idempotencyKey:crypto.randomUUID()
 })).record;
 const wrongOwnerAccount=(await directory.accountCreate(conn,tenant,owner,{
  customerId:String(anotherCustomer._id),accountNumber:'FOREIGN-OWNER-'+nonce.toUpperCase(),
  currency:'USD',type:'Current Account',status:'active',risk:'Low',idempotencyKey:crypto.randomUUID()
 })).record;
 await assert.rejects(bankFx.preview(conn,tenant,owner,branch,{
  ...fxBankInput,destinationAccountId:String(wrongOwnerAccount._id)
 }),error=>error.status===409&&/same customer/.test(error.message));
 await assert.rejects(bankFx.convert(conn,tenant,owner,branch,{
  ...fxBankInput,idempotencyKey:crypto.randomUUID(),destinationAccountId:String(wrongOwnerAccount._id)
 }),error=>error.status===409&&/same customer/.test(error.message));
 const bankFxPosted=await bankFx.convert(conn,tenant,owner,branch,fxBankInput);
 assert.equal(bankFxPosted.record.state,'posted_internal');
 assert.equal(bankFxPosted.record.journalIds.length,2);
 assert.equal((await bankFx.convert(conn,tenant,owner,branch,fxBankInput)).duplicate,true);
 const priorFxJournalCount=await core.ledgerJournalModel(conn).countDocuments();
 await assert.rejects(bankFx.convert(conn,tenant,owner,branch,{
  ...fxBankInput,idempotencyKey:crypto.randomUUID()
 }),error=>error.status===409&&/voucher/.test(error.message),
 'a second generated transaction ID cannot reuse a posted customer-approved voucher');
 assert.equal(await core.ledgerJournalModel(conn).countDocuments(),priorFxJournalCount,
  'blocked duplicate customer voucher cannot create extra books');
 assert.equal(await customerBook(accountA),3000n,'Bank FX source liability debited once');
 assert.equal(await customerBook(usdAccount),54n,'Bank FX USD customer liability credited once');
 await assert.rejects(bankFx.convert(conn,tenant,owner,branch,{...fxBankInput,
  idempotencyKey:crypto.randomUUID(),rateDecimal:'0.00028'}),
  error=>error.status===409&&/rate/.test(error.message),'client cannot change an approved Forex rate');
 const actualBankFx=await require('../src/tenant/services/financeOverview.service').postedBankingInternalFxActivity(
  conn,tenant,owner,branch,{moduleKey:'banking',timeZone:'Africa/Juba'});
 assert.equal(actualBankFx.count,1);
 assert.equal(actualBankFx.source[0].formatted,'UGX 2,000');
 assert.equal(actualBankFx.destination[0].formatted,'USD 0.54');
 const journalBeforeDenied=await core.ledgerJournalModel(conn).countDocuments();
 await assert.rejects(bankFx.convert(conn,tenant,owner,branch,{...fxBankInput,idempotencyKey:crypto.randomUUID(),
  evidenceReference:'BANKFX-INSUFFICIENT-'+nonce,amount:'20000'}),
  error=>error.status===409&&/Insufficient/.test(error.message));
 assert.equal(await core.ledgerJournalModel(conn).countDocuments(),journalBeforeDenied);
 await assert.rejects(bankFx.convert(conn,tenant,auditor,branch,{...fxBankInput,idempotencyKey:crypto.randomUUID(),
  evidenceReference:'BANKFX-UNAUTHORIZED-'+nonce}),{status:403});
 await assert.rejects(bankFx.convert(other,tenant,owner,branch,{...fxBankInput,idempotencyKey:crypto.randomUUID(),
  evidenceReference:'BANKFX-CROSS-TENANT-'+nonce}),{status:403});
 assert.equal((await bankFx.history(conn,tenant,owner,branch)).length,1);
 for(const ccy of ['UGX','USD'])assert.equal((await ledger.trialBalance(conn,{branchId:String(branch._id),currency:ccy})).balanced,true);
 const logs=JSON.stringify(await core.auditEventModel(conn).find({}).lean());assert(!logs.includes(revealed.pin),'audit must never contain payout PIN');
 console.log('PASS: native-currency manual finance, standalone Forex, atomic internal Banking FX, immediate PIN-verified UGX/SSP remittance payout, correct cross-module reports, idempotency, insufficient balance rollback, journal integrity and tenant/role isolation.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_funded_probe_[a-f0-9]{16}$/.test(platformName)){for(const connection of connections)await connection.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('FUNDED OPERATIONS INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Funded scratch cleanup failed:',error.message);process.exitCode=1;}));
