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
 // The Forex summary is a database-backed completed-execution view, not merely
 // an array of quotes. It uses the operating branch's local business day.
 const businessTime=require('../src/utils/businessTime'),fxZone=businessTime.forBranch(branch),
  fxDay=businessTime.localDay(new Date(),fxZone);
 const forexReport=await require('../src/tenant/services/operationWorkspace.service').report(
  conn,tenant,owner,'forex',{from:fxDay,to:fxDay},fxZone);
 assert.equal(forexReport.finalizedForexCount,2,'two final cash exchanges must appear in the Forex summary');
 assert.equal(forexReport.finalizedForexRows.filter(row=>row.kind==='buy').length,1);
 assert.equal(forexReport.finalizedForexRows.filter(row=>row.kind==='sell').length,1);
 assert.match(require('../src/tenant/services/operationWorkspace.service').csv(forexReport),/Final Treasury posting/);
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
 const fxRequest=requestData({verificationToken:fxMatched.token,payoutAccountId:String(sspCash._id)});
 const missingPayoutCtx=await funded.payoutContext(conn,tenant,owner,fxMatched);
 assert(missingPayoutCtx.payoutAccounts.some(a=>String(a._id)===String(cashFund._id)),'native payout remains available');
 assert(!missingPayoutCtx.payoutAccounts.some(a=>String(a._id)===String(sspCash._id)));
 assert(missingPayoutCtx.rateIssues.some(message=>/No Buy rate for UGX → SSP is set/.test(message)));
 await assert.rejects(funded.requestPayout(conn,tenant,owner,fxRequest),{status:409,code:'FX_RATE_MISSING'});
 const ugxSspRateProposal=await forex.proposeRate(conn,tenant,owner,{
  fromCurrency:'UGX',toCurrency:'SSP',side:'buy',rateDecimal:'1.2',validHours:24,
  note:'Independently checked cash-remittance exchange rate for genuine UGX to SSP payout'});
 const ugxSspRate=await forex.decideRate(conn,tenant,reviewer,ugxSspRateProposal._id,reviewData);
 const rateRef={_id:ugxSspRate._id};
 const Rate=core.forexRateModel(conn).collection;
 const expiresAt=ugxSspRate.expiresAt;
 const payoutChoice={...fxRequest,rateChoice:`${ugxSspRate._id}:${ugxSspRate.revision}:${ugxSspRate.rateDecimal}`};
 await Rate.updateOne(rateRef,{$set:{expiresAt:new Date(Date.now()-1000)}});
 const expiredPayoutCtx=await funded.payoutContext(conn,tenant,owner,fxMatched);
 assert(!expiredPayoutCtx.payoutAccounts.some(a=>String(a._id)===String(sspCash._id)));
 assert(expiredPayoutCtx.rateIssues.some(message=>/Buy rate for UGX → SSP has expired/.test(message)));
 await assert.rejects(funded.requestPayout(conn,tenant,owner,payoutChoice),{status:409,code:'FX_RATE_EXPIRED'});
 await Rate.updateOne(rateRef,{$set:{expiresAt:new Date(Date.now()+30000)}});
 const expiringPayoutCtx=await funded.payoutContext(conn,tenant,owner,fxMatched);
 assert(expiringPayoutCtx.rateIssues.some(message=>/Buy rate for UGX → SSP expires too soon/.test(message)));
 await assert.rejects(funded.requestPayout(conn,tenant,owner,payoutChoice),{status:409,code:'FX_RATE_EXPIRING'});
 await Rate.updateOne(rateRef,{$set:{expiresAt}});
 const fxPayoutCtx=await funded.payoutContext(conn,tenant,owner,fxMatched);
 assert(fxPayoutCtx.fxRates.some(r=>String(r._id)===String(ugxSspRate._id)));
 assert.equal(fxPayoutCtx.payoutAccounts.find(a=>String(a._id)===String(sspCash._id)).payoutAmount,'SSP 12,000.00');
 const sspBefore=await book(sspCash),clearingBefore=await book(clearing);
 assert.equal(clearingBefore,10000n);
 const fxPayout=await funded.requestPayout(conn,tenant,owner,payoutChoice);
 assert.equal(fxPayout.sameBranch,true);
 assert.equal(String(fxPayout.execution.payoutFx.targetCurrency),'SSP');
 assert.equal(String(fxPayout.execution.payoutFx.payoutMinor),'1200000');
 assert.equal(await book(sspCash),sspBefore,'creating a payout request cannot release SSP funds');
 await assert.rejects(funded.finalizePayout(conn,tenant,owner,fxPayout.execution._id,{
  confirmRecipientVerified:'yes'}),{status:403},'a payout without physical handover confirmation cannot post');
 await Rate.updateOne(rateRef,{$set:{expiresAt:new Date(Date.now()-1000)}});
 await assert.rejects(funded.finalizePayout(conn,tenant,owner,fxPayout.execution._id,{
  confirmRecipientVerified:'yes',confirmCashPaid:'yes'
 }),{status:409,code:'FX_RATE_EXPIRED'},'a payout cannot post against a rate that expired after verification');
 await Rate.updateOne(rateRef,{$set:{expiresAt}});
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
 const directDeposit=require('../src/tenant/customerAccounts/deposit');
 const depositAccount=await acct('DIRECT-DEPOSIT-'+nonce.toUpperCase());
 const depositInput=requestData({cashAccountId:String(cashFund._id),amount:'12345',pricingMode:'configured',pricingPolicy:'default',fee:'9999',confirmActualMoney:'yes'});
 const customerAccount=await directory.accountDetail(conn,tenant,owner,depositAccount._id);
 assert((await directDeposit.options(conn,tenant,owner,customerAccount)).some(account=>String(account._id)===depositInput.cashAccountId));
 assert.deepEqual(await directDeposit.options(conn,tenant,reviewer,customerAccount),[]);
 const requestsBefore=await core.bankingRequestModel(conn).countDocuments(),customerBefore=await customerBook(depositAccount),drawerBefore=await book(cashFund);
 const bankingUsage=await Usage.findOne({tenantId:tenant._id,metric:'banking_requests'}).lean();
 await assert.rejects(directDeposit.request(conn,tenant,owner,depositAccount._id,{...depositInput,confirmActualMoney:''}),{status:400});
 await assert.rejects(directDeposit.request(conn,tenant,owner,depositAccount._id,{...depositInput,pricingPolicy:'stale-policy'}),{status:409});
 await assert.rejects(directDeposit.request(conn,tenant,owner,depositAccount._id,{...depositInput,evidenceReference:''}),{status:400});
 assert.equal(await core.bankingRequestModel(conn).countDocuments(),requestsBefore,'invalid evidence rolls back the banking request');
 assert.equal((await Usage.findById(bankingUsage._id)).quantity,bankingUsage.quantity,'invalid evidence rolls back the request quota reservation');
 const directResults=await Promise.all([directDeposit.request(conn,tenant,owner,depositAccount._id,depositInput),directDeposit.request(conn,tenant,owner,depositAccount._id,depositInput)]);
 assert.equal(directResults.filter(result=>result.duplicate).length,1);
 const directExecution=directResults[0].execution;
 assert.equal(String(directExecution._id),String(directResults[1].execution._id));
 assert.equal(directExecution.status,'posted_manual');
 assert.equal(directExecution.sourceSnapshot.feeMinor,'0','the submitted display fee cannot override configured charges');
 assert.equal((await funded.detail(conn,tenant,reviewer,directExecution._id)).receivingAccountName,cashFund.name);
 assert.equal((await core.bankingRequestModel(conn).findById(directExecution.sourceId)).directDeposit,true);
 assert.equal(await core.bankingRequestModel(conn).countDocuments(),requestsBefore+1);
 assert.equal(await book(cashFund),drawerBefore+12345n);
 assert.equal(await customerBook(depositAccount),customerBefore+12345n);
 assert(await core.auditEventModel(conn).exists({targetId:directExecution._id,'metadata.evidenceMode':'tenant_owner_reconciliation'}));
 await assert.rejects(directDeposit.request(conn,tenant,owner,depositAccount._id,{...depositInput,amount:'12346'}),{status:409});

 const historicalAccount=await acct('OLD-DEPOSIT-'+nonce.toUpperCase());
 async function historicalDeposit(amount){
  // Pre-upgrade owners could submit these records but could not post or return them.
  const session=await conn.startSession();
  const input={...depositInput,idempotencyKey:crypto.randomUUID(),amount};
  try{return await session.withTransaction(async()=>{
   const {order}=await banking.createRequest(conn,tenant,owner,{
    ...input,kind:'deposit_request',sourceId:'account:'+historicalAccount._id,currency:'UGX',paymentChannel:'Cash',fee:undefined
   },{session,directDeposit:true});
   return funded.request(conn,tenant,owner,'banking',order._id,input,{session});
  });}finally{await session.endSession();}
 }
 const historical=(await historicalDeposit('100')).execution;
 const returned=(await historicalDeposit('20')).execution;
 const pending=await directDeposit.pendingForOwner(conn,tenant,owner,{branchId:String(branch._id),accountId:String(cashFund._id)});
 assert(pending.some(row=>String(row._id)===String(historical._id)));
 assert.deepEqual(await directDeposit.pendingForOwner(conn,tenant,reviewer,{accountId:String(cashFund._id)}),[]);
 assert(!(await banking.reviewQueue(conn,tenant,reviewer)).some(order=>String(order._id)===String(historical.sourceId)));
 await assert.rejects(banking.decide(conn,tenant,reviewer,historical.sourceId,reviewData),{status:409});
 await assert.rejects(banking.cancel(conn,tenant,owner,historical.sourceId,reviewData),{status:409});
 await assert.rejects(funded.prepare(conn,tenant,owner,'banking',historical.sourceId),{status:409});
 await banking.expireDue(conn,new Date(Date.now()+8*86400000));
 assert.equal((await core.bankingRequestModel(conn).findById(historical.sourceId)).status,'requested');
 const pendingAccount=await directory.accountDetail(conn,tenant,owner,historicalAccount._id);
 await assert.rejects(directory.accountUpdate(conn,tenant,owner,historicalAccount._id,{status:'closed',revision:pendingAccount.revision}),
  error=>error.status===409&&/pending deposit/.test(error.message));
 await assert.rejects(cash.submit(conn,tenant,owner,shift._id,{countedCash:String(drawerBefore+12445n)}),error=>error.status===409&&/pending money entries/.test(error.message));
 assert.equal((await funded.detail(conn,tenant,owner,historical._id)).canFinalizeCashier,false);
 await assert.rejects(funded.finalizeCashier(conn,tenant,owner,historical._id,{confirmFinalMovement:'yes'}),{status:403});
 await assert.rejects(funded.resolveByOwner(conn,tenant,reviewer,historical._id,{...reviewData,confirmActualMoney:'yes'}),{status:403});
 await assert.rejects(funded.resolveByOwner(conn,tenant,owner,historical._id,reviewData),{status:400});
 const ownerReview={...reviewData,confirmActualMoney:'yes'};
 await funded.resolveByOwner(conn,tenant,owner,historical._id,ownerReview);
 assert.equal((await funded.resolveByOwner(conn,tenant,owner,historical._id,ownerReview)).duplicate,true);
 assert.equal(await customerBook(historicalAccount),100n);
 await funded.resolveByOwner(conn,tenant,owner,returned._id,{decision:'reject',note:'Receipt amount needs correction before posting'});
 const returnedSource=await core.bankingRequestModel(conn).findById(returned.sourceId).lean();
 assert.equal(returnedSource.status,'rejected');
 assert.equal(String(returnedSource.reviewedBy),owner.id);
 assert.equal(await customerBook(historicalAccount),100n);
 assert.equal(await book(cashFund),drawerBefore+12445n);

 const closing=await core.cashSessionModel(conn).findById(shift._id).lean();assert.equal(BigInt(String(closing.openingMinor))+BigInt(String(closing.provisionalMovementMinor)),await book(cashFund));
 await cash.submit(conn,tenant,owner,shift._id,{countedCash:String(await book(cashFund)),note:'Physical drawer count agrees with all posted manual module movements'});await cash.decide(conn,tenant,reviewer,shift._id,{decision:'approve',note:'Independent multi-module cash closing count matches the treasury book'});
 assert.equal((await core.cashSessionModel(conn).findById(shift._id)).status,'approved');
 assert.equal(await customerBook(depositAccount),customerBefore+12345n,'closing the cash day does not spend or remove the customer balance');
 assert((await directDeposit.request(conn,tenant,owner,depositAccount._id,depositInput)).duplicate,'an identical retry retains its completed deposit after cash day closes');
 assert(!(await directDeposit.options(conn,tenant,owner,customerAccount)).some(account=>String(account._id)===depositInput.cashAccountId));
 // Every cash-handling module owns its own actual independently verified
 // drawer. The expected cash report must only show an operator's own drawer.
 const operatorDrawers=[];
 for(const [role,moduleKey,opening] of [['Banking Operator','banking','10000'],['Forex Operator','forex','20000'],['Money Transfer Operator','money_transfer','30000'],['Mobile Money Operator','mobile_money','40000']]){
  const actor={id:String(new mongoose.Types.ObjectId()),name:role,role,permissions:permissionsFor(role),allowedModules:[moduleKey],branchId:String(branch._id),authVersion:0};
  await core.tenantUserModel(conn).create({_id:actor.id,name:actor.name,email:`${actor.id}@example.invalid`,passwordHash:'scratch-not-a-real-password',role,branchId:actor.branchId,allowedModules:[moduleKey],status:'active',authVersion:0});
  const ownShift=await cash.open(conn,tenant,actor,{openingCash:opening});await cash.decideOpening(conn,tenant,reviewer,ownShift._id,{decision:'approve',note:'Independent physical count for the separately assigned module operator drawer'});
  operatorDrawers.push({actor,opening});
 }
 for(const {actor,opening} of operatorDrawers){
  const actual=await cash.expectedCash(conn,tenant,actor,branch);
  assert.equal(actual.length,1,actor.role);assert.equal(actual[0].shiftCount,1,actor.role+' must see only its own drawer');
  assert.equal(actual[0].expectedFormatted,require('../src/tenant/services/mobileMoney.service').formatMoneyMinor(opening,'UGX'));
  for(const denied of [{...actor,permissions:actor.permissions.filter(permission=>permission!=='treasury.view')},{...actor,allowedModules:[]},{...actor,role:'Viewer',permissions:['*']}]){
   assert.deepEqual(await cash.expectedCash(conn,tenant,denied,branch),[]);
  }
  assert.deepEqual(await cash.expectedCash(conn,tenant,actor,{...branch.toObject(),_id:new mongoose.Types.ObjectId()}),[]);
 }
 const branchCash=await cash.expectedCash(conn,tenant,reviewer,branch);const ugxCash=branchCash.find(row=>row.currency==='UGX');
 assert(ugxCash,'reviewer must see actual UGX currency cash independently');
 assert.equal(ugxCash.shiftCount,4);
 assert.equal(ugxCash.expectedFormatted,'UGX 100,000');
 assert(branchCash.some(row=>row.currency==='SSP'),'reviewer must see SSP cash separately rather than merging currencies');
 const pendingActor={...operatorDrawers[0].actor,id:String(new mongoose.Types.ObjectId())};
 await core.tenantUserModel(conn).create({_id:pendingActor.id,name:'Pending operator',email:`${pendingActor.id}@example.invalid`,passwordHash:'scratch-not-a-real-password',role:pendingActor.role,branchId:pendingActor.branchId,allowedModules:pendingActor.allowedModules,status:'active',authVersion:0});
 await cash.open(conn,tenant,pendingActor,{openingCash:'5000'});
 assert.deepEqual(await cash.expectedCash(conn,tenant,pendingActor,branch),[]);
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
 const dashboard=require('../src/tenant/services/dashboardVolumes.service');
 const dashboardInput={timeZone:fxZone,now:new Date(bankFxPosted.record.postedAt)};
 const dashboardSummary=await dashboard.volumes(conn,tenant,owner,dashboardInput,branch);
 const row=(key,ccy)=>dashboardSummary.todayByCurrency[key].find(item=>item.currency===ccy);
 assert.equal(row('forex','USD').amountMinor,'1554','two native forex legs plus the Banking FX dollar credit');
 assert.equal(row('forex','UGX').amountMinor,'67500','two native forex legs plus one PIN payout and one Banking FX debit');
 assert.equal(row('forex','SSP').amountMinor,'1200000');
 assert.equal(row('banking','USD').amountMinor,'54');
 assert.equal(row('money_transfer','SSP').amountMinor,'1200000');
 assert.equal(row('money_transfer','UGX').count,2,'a collection and payout share one receipt');
 assert.equal(dashboardSummary.todayTransactionCount,row('banking','UGX').count+4,'native receipts count once across modules and currencies');
 const {activity}=require('../src/tenant/services/ownerReportActivity.service');
 const range=dashboard.bounds(dashboardInput.now,fxZone);
 const beforeDowngrade=await activity(conn,tenant,owner,{branch,dateRange:range});
 assert.equal(beforeDowngrade.totalCount,dashboardSummary.todayTransactionCount);
 assert.deepEqual(beforeDowngrade.byCurrency.find(item=>item.currency==='SSP'),
  {currency:'SSP',count:1,amountMinor:'1200000'},'cross-module attribution adds no duplicate native totals');
 assert.equal(beforeDowngrade.byModule.find(item=>item.moduleKey==='forex'&&item.currency==='USD').amountMinor,'1554');
 assert.equal(beforeDowngrade.byModule.find(item=>item.moduleKey==='banking'&&item.currency==='USD').amountMinor,'54');
 const reportOnly={...tenant.toObject(),enabledModules:['reports'],
  subscription:{...tenant.subscription.toObject(),modules:['reports']}};
 assert.deepEqual(await activity(conn,reportOnly,owner,{branch,dateRange:range}),beforeDowngrade,
  'a module downgrade does not hide historical transactions from the tenant owner');
 await assert.rejects(activity(conn,tenant,auditor,{branch,dateRange:range}),{status:403});
 await assert.rejects(activity(other,tenant,owner,{branch,dateRange:range}),{status:403});
 const historyDate=new Date(Date.UTC(dashboardInput.now.getUTCFullYear()-1,0,1,12));
 const historyRange=dashboard.bounds(historyDate,fxZone);
 const legacyMobile={branchId:branch._id,operatorId:owner.id,operation:'cash_in',
  customer:'Recorded provider receipt',network:'MTN',currency:'UGX',amountMinor:'70',feeMinor:'4',
  createdAt:historyDate,fundingState:'legacy_untracked'};
 await core.mobileTransactionModel(conn).create([
  {...legacyMobile,idempotencyKey:crypto.randomUUID(),networkReference:'LEGACY-COMPLETE-'+nonce,status:'recorded'},
  {...legacyMobile,idempotencyKey:crypto.randomUUID(),networkReference:'LEGACY-PENDING-'+nonce,status:'pending_verification',
   reviewState:'awaiting_review'},
  {...legacyMobile,idempotencyKey:crypto.randomUUID(),networkReference:'LEGACY-VOIDED-'+nonce,status:'voided_internal'}
 ]);
 const expense={expenseType:'Transport',amountMinor:'80',description:'Legacy approved cash expense'};
 await require('../src/tenant/models/expenses').expenseModel(conn).create({
  ...expense,original:expense,branchId:branch._id,operatorId:owner.id,currency:'UGX',paymentMethod:'Cash',
  status:'approved',reviewedAt:historyDate,idempotencyKey:crypto.randomUUID(),recordReference:'LEGACY-EXPENSE-'+nonce
 });
 await fundedModel.models(conn).execution.create({
  sourceType:'forex',sourceId:new mongoose.Types.ObjectId(),sourceReference:'LEGACY-LINKED-'+nonce,
  action:'forex',branchId:branch._id,createdBy:owner.id,idempotencyKey:crypto.randomUUID(),
  fingerprint:'a'.repeat(64),sourceFingerprint:'b'.repeat(64),accounts:{},
  sourceSnapshot:{operation:'buy',originModule:'banking',originRecordId:String(depositSource._id),
   fromCurrency:'USD',toCurrency:'UGX',sourceMinor:'100',targetMinor:'3700'},
  evidenceReference:'LEGACY-VOUCHER',note:'Historic linked exchange with separate journals recorded',
  reviewedAt:historyDate,status:'posted_manual',journalIds:bankFxPosted.record.journalIds
 });
 assert.deepEqual(await activity(conn,reportOnly,owner,{branch,dateRange:historyRange}),{
  totalCount:3,
  byCurrency:[{currency:'UGX',count:3,amountMinor:'3850'},{currency:'USD',count:1,amountMinor:'100'}],
  byModule:[
   {moduleKey:'mobile_money',currency:'UGX',count:1,amountMinor:'70'},
   {moduleKey:'banking',currency:'UGX',count:1,amountMinor:'3700'},
   {moduleKey:'banking',currency:'USD',count:1,amountMinor:'100'},
   {moduleKey:'forex',currency:'UGX',count:1,amountMinor:'3700'},
   {moduleKey:'forex',currency:'USD',count:1,amountMinor:'100'},
   {moduleKey:'expenses',currency:'UGX',count:1,amountMinor:'80'}
  ]
 },'owner history includes completed legacy receipts and skips pending and voided records');
 assert.equal((await dashboard.volumes(conn,tenant,owner,{now:historyDate,timeZone:fxZone},branch)).todayTransactionCount,0,
  'dashboard volumes continue to require booked fund movements');
 const sspDashboard=await dashboard.volumes(conn,tenant,owner,{...dashboardInput,currency:'SSP'},branch);
 assert.equal(sspDashboard.todayTransactionCount,1,'a cross-currency payout counts once for its destination currency');
 const restricted={...operatorDrawers.find(item=>item.actor.role==='Forex Operator').actor};
 const staffDashboard=await dashboard.volumes(conn,tenant,restricted,dashboardInput,branch);
 assert.deepEqual(staffDashboard.todayByCurrency.forex,[],'forex cashiers only see authorized receipts created by them');
 assert.equal(staffDashboard.todayByCurrency.banking,undefined);
 const expiryInput={...fxBankInput,idempotencyKey:crypto.randomUUID(),evidenceReference:'BANKFX-EXPIRED-'+nonce};
 await core.forexRateModel(conn).collection.updateOne({_id:ugxUsdRate._id},{$set:{expiresAt:new Date(Date.now()-1000)}});
 const expiredRate=error=>error.status===409&&error.code==='FX_RATE_EXPIRED'&&/UGX → USD has expired/.test(error.message);
 await assert.rejects(bankFx.preview(conn,tenant,owner,branch,expiryInput),expiredRate);
 await assert.rejects(bankFx.convert(conn,tenant,owner,branch,expiryInput),expiredRate);
 const sspAccount=(await directory.accountCreate(conn,tenant,owner,{
  customerId:String(customer._id),accountNumber:'FUNDED-SSP-'+nonce.toUpperCase(),
  currency:'SSP',type:'Current Account',status:'active',risk:'Low',idempotencyKey:crypto.randomUUID()
 })).record;
 await assert.rejects(bankFx.preview(conn,tenant,owner,branch,{
  ...expiryInput,sourceAccountId:String(usdAccount._id),destinationAccountId:String(sspAccount._id),rateId:null
 }),error=>error.status===409&&error.code==='FX_RATE_MISSING'&&/USD → SSP/.test(error.message));
 assert.equal(await core.ledgerJournalModel(conn).countDocuments(),journalBeforeDenied,'invalid rate cannot post either currency');
 for(const ccy of ['UGX','USD'])assert.equal((await ledger.trialBalance(conn,{branchId:String(branch._id),currency:ccy})).balanced,true);
 const logs=JSON.stringify(await core.auditEventModel(conn).find({}).lean());assert(!logs.includes(revealed.pin),'audit must never contain payout PIN');
 console.log('PASS: atomic customer deposits, native-currency manual finance, standalone Forex, atomic internal Banking FX, immediate PIN-verified UGX/SSP remittance payout, correct cross-module reports, idempotency, insufficient balance rollback, journal integrity and tenant/role isolation.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_funded_probe_[a-f0-9]{16}$/.test(platformName)){for(const connection of connections)await connection.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('FUNDED OPERATIONS INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Funded scratch cleanup failed:',error.message);process.exitCode=1;}));
