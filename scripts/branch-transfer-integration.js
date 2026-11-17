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
const oid=()=>String(new mongoose.Types.ObjectId()),owner={id:oid(),role:'Tenant Owner',permissions:['*'],allowedModules:['money_transfer','forex'],authVersion:0},teller={id:oid(),role:'Money Transfer Operator',permissions:permissionsFor('Money Transfer Operator'),allowedModules:['money_transfer'],authVersion:0};
const decision={decision:'approve',note:'Independent source evidence and actual counted funds reviewed'};
const input=()=>({idempotencyKey:crypto.randomUUID(),evidenceReference:'ACTUAL-COUNT-'+nonce,note:'Actual collected cash and signed transfer instruction inspected'});
const delivered=[];
const transport=async value=>{delivered.push(value);return {status:'accepted',messageId:'SM'+'a'.repeat(32),providerState:'queued'};};
function workerCredentials(){process.env.TWILIO_ACCOUNT_SID='AC'+'1'.repeat(32);process.env.TWILIO_AUTH_TOKEN='2'.repeat(32);process.env.TWILIO_FROM_NUMBER='+256700999000';}
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Tenant.createIndexes();await require('../src/platform/models/LoginThrottle').createIndexes();conn=getTenantConnection(slug);await funded.prepareIndexes(conn);
 const terms=commerce.planSnapshot({...commerce.asPlanVersion({...require('../src/data/store').plans.find(plan=>plan.code==='enterprise'),code:'transfer_sms_probe',modules:['money_transfer','forex']}),status:'published'});
 const tenant=await Tenant.create({name:'SMS transfer proof',slug,dbName:conn.name,owner:'Owner',email:`${nonce}@example.invalid`,plan:terms.planCode,status:'active',setupStatus:'complete',enabledModules:['money_transfer','forex'],seatsReserved:2,branchCount:1,subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const branch=await core.branchModel(conn).create({name:'Main payout office',code:'main',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
 owner.branchId=teller.branchId=String(branch._id);
 for(const actor of [owner,teller])await core.tenantUserModel(conn).create({_id:actor.id,name:actor.role,email:`${actor.id}@example.invalid`,passwordHash:'isolated-test-only',role:actor.role,branchId:branch._id,allowedModules:actor.allowedModules,authVersion:0,...(actor===owner?{mfaEnabledAt:new Date()}: {})});
 async function opened(kind,code,balance,operatorId){const account=await treasury.createAccount(conn,tenant,owner,{kind,code,name:code,currency:'UGX',isDefault:true,...(operatorId?{operatorId}:{})});const observation=await treasury.requestObservation(conn,tenant,teller,account._id,{kind:'opening',actualBalance:balance,observedAt:new Date(Date.now()-1000).toISOString(),evidenceType:kind==='cash'?'cash_count':'transfer_register',evidenceReference:'OPEN-'+code,note:'Actual original balances independently counted before operating',idempotencyKey:crypto.randomUUID()});await treasury.reviewObservation(conn,tenant,owner,observation.observation._id,decision);return account;}
 const drawer=await opened('cash','TELLER_CASH','1000000',teller.id),payable=await opened('transfer_clearing','TRANSFER_PAYABLE','0');
 const shift=await cash.open(conn,tenant,teller,{openingCash:'1000000'});await cash.decideOpening(conn,tenant,owner,shift._id,decision);


 const destination=await core.branchModel(conn).create({name:'Receiving branch',code:'receiving',currency:'UGX',currencies:['UGX','SSP','USD'],createdBy:owner.id,updatedBy:owner.id});
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
 const beforeInvalid=await core.transferOrderModel(conn).countDocuments();
 for(const destinationBranchId of [undefined,'',String(branch._id),String(branch._id).toUpperCase()])await assert.rejects(transfer.createRequest(conn,tenant,teller,{...sourceInput,destinationBranchId}),{status:400},'every new transfer requires a different receiving branch');
 await assert.rejects(transfer.createRequest(conn,tenant,teller,{...sourceInput,fromBranchId:String(destination._id)}),{status:403},'the source branch cannot be changed by the form');
 assert.equal(await core.transferOrderModel(conn).countDocuments(),beforeInvalid,'invalid routes create no order or economic obligation');
 await assert.rejects(transfer.createRequest(conn,tenant,teller,{...sourceInput,destinationBranchId:oid()}),{status:409});
 await assert.rejects(transfer.createRequest(conn,tenant,teller,{...sourceInput,branchId:String(destination._id)}),{status:403});
 const source=(await transfer.createRequest(conn,tenant,teller,sourceInput)).order;assert((await transfer.createRequest(conn,tenant,teller,sourceInput)).duplicate);
 await assert.rejects(transfer.createRequest(conn,tenant,teller,{...sourceInput,destinationBranchId:String(branch._id)}),{status:400});
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

 // Real cross-branch SSP -> USD, separate physical drawers and currency books.
 process.env.CLASSICFIN_LINKED_CURRENCY_POSTING='enabled';
 await require('../src/tenant/settlements/models').ensure(conn);
 await core.tenantUserModel(conn).updateOne({_id:teller.id},{$set:{status:'active'}});
 teller.authVersion=1;
 // Real same-currency cross-branch custody reimbursement. The collecting
 // cashier sends original UGX banknotes to the teller who already paid UGX.
 // Both real cash accounts and interbranch dues must change atomically.
 process.env.CLASSICFIN_INTERBRANCH_CASH_SETTLEMENT='enabled';
 const physical=require('../src/tenant/settlements/interbranchCash.service');
 await require('../src/tenant/settlements/interbranchCash.models').ensure(conn);
 const originalUGX=BigInt(await amount(drawer._id));
 const receiverUGX=BigInt(await amount(destinationCash._id));
 const settlementInput=label=>({
  idempotencyKey:crypto.randomUUID(),
  evidenceReference:'SENDER-UGX-HANDOVER-'+label+'-'+nonce,
  note:'Origin cashier presents counted UGX notes for independent branch reimbursement'
 });
 const rejectedCash=(await physical.request(conn,tenant,teller,source._id,settlementInput('REJECT'))).reimbursement;
 assert.equal(rejectedCash.status,'pending_receiver');
 const rejectedReceiving=await physical.confirmReceipt(conn,tenant,receivingTeller,rejectedCash._id,{
  receiverReceiptReference:'DEST-REJECTED-UGX-'+nonce,
  receiverNote:'Actual receiving cashier counted original rejected reimbursement evidence',
  cashCountConfirmed:'confirmed'
 },source._id);
 assert.equal(rejectedReceiving.reimbursement.status,'pending_review');
 const refused=await physical.review(conn,tenant,owner,rejectedCash._id,{
  decision:'reject',note:'Receiving-branch signed cash proof had not yet arrived'},source._id);
 assert.equal(refused.reimbursement.status,'rejected');
 assert.equal(await amount(drawer._id),String(originalUGX));
 assert.equal(await amount(destinationCash._id),String(receiverUGX));
 const actual=(await physical.request(conn,tenant,teller,source._id,settlementInput('FINAL'))).reimbursement;
 assert.equal(actual.status,'pending_receiver');
 await assert.rejects(physical.request(conn,tenant,teller,source._id,settlementInput('EXTRA')),{status:409});
 await assert.rejects(physical.review(conn,tenant,owner,actual._id,{
  decision:'approve',note:'Without confirmed receiving cash no posting is allowed',
  senderHandoverReference:'SENDER-UGX-HANDOVER-FINAL-'+nonce,
  receiverReceiptReference:'DESTINATION-SIGNED-'+nonce,bothBranchesVerified:'confirmed'
 },source._id),{status:409},'Owner cannot invent a receiving cashier receipt');
 await assert.rejects(physical.confirmReceipt(conn,tenant,teller,actual._id,{
  receiverReceiptReference:'DESTINATION-SIGNED-'+nonce,
  receiverNote:'Wrong sender cashier cannot confirm destination physical cash',
  cashCountConfirmed:'confirmed'
 },source._id),{status:403});
 const confirmedCash=await physical.confirmReceipt(conn,tenant,receivingTeller,actual._id,{
  receiverReceiptReference:'DESTINATION-SIGNED-'+nonce,
  receiverNote:'Counted and signed for actual UGX cash delivered by sending branch',
  cashCountConfirmed:'confirmed'
 },source._id);
 assert.equal(confirmedCash.reimbursement.status,'pending_review');
 await assert.rejects(physical.confirmReceipt(conn,tenant,receivingTeller,actual._id,{
  receiverReceiptReference:'DESTINATION-SIGNED-'+nonce,
  receiverNote:'Second confirmation must not be accepted',
  cashCountConfirmed:'confirmed'
 },source._id),{status:409});
 const postedCashDecision={
  decision:'approve',note:'Both branches signed for exact counted original UGX handover',
  senderHandoverReference:'SENDER-UGX-HANDOVER-FINAL-'+nonce,
  receiverReceiptReference:'DESTINATION-SIGNED-'+nonce,
  bothBranchesVerified:'confirmed'
 };
 await assert.rejects(physical.review(conn,tenant,teller,actual._id,postedCashDecision,source._id),
  {status:403},'The collecting teller cannot approve their own physical reimbursement');
 await assert.rejects(physical.review(conn,tenant,owner,actual._id,{
  ...postedCashDecision,receiverReceiptReference:postedCashDecision.senderHandoverReference
 },source._id),{status:400},'Sender and receiver need distinct independently signed proof');
 await assert.rejects(physical.review(conn,tenant,owner,actual._id,postedCashDecision,oid()),
  {status:403},'An unrelated transfer URL cannot redirect a cash reimbursement');
 const realResults=await Promise.allSettled([
  physical.review(conn,tenant,owner,actual._id,postedCashDecision,source._id),
  physical.review(conn,tenant,owner,actual._id,postedCashDecision,source._id)
 ]);
 assert.equal(realResults.filter(x=>x.status==='fulfilled').length,1,
  'Concurrent physical settlement approvals may post exactly one pair of custody batches');
 assert.equal(realResults.filter(x=>x.status==='rejected').length,1);
 const done=realResults.find(x=>x.status==='fulfilled').value.reimbursement;
 assert.equal(done.status,'posted');
 assert(done.originBatchId&&done.destinationBatchId);
 assert.equal(await amount(drawer._id),String(originalUGX-10000n));
 assert.equal(await amount(destinationCash._id),String(receiverUGX+10000n));
 assert.equal((await core.transferOrderModel(conn).findById(source._id)).status,'paid_out_manual',
  'Interbranch reimbursement never changes the actual customer payout history');
 const balancesAfterReimbursement=await transfer.branchBalances(conn,tenant,owner);
 const netUg=balancesAfterReimbursement.rows.filter(x=>x.currency==='UGX');
 assert(netUg.every(x=>/UGX 0\b/.test(x.payable)&&/UGX 0\b/.test(x.receivable)),
  'The actual same-currency payable and receivable must both be fully cleared');
 for(const branchKey of [branch,destination])
  assert.equal((await ledger.trialBalance(conn,{
   branchId:String(branchKey._id),currency:'UGX'})).balanced,true);
 for(const account of [drawer,destinationCash])
  await treasury.assertBookIntegrity(conn,null,
   await treasury.models(conn).account.findById(account._id).lean());
 const postedEvidence=await physical.detail(conn,tenant,owner,source._id);
 assert.equal(postedEvidence[0].status,'posted');
 assert.equal(postedEvidence[0].receiverReceiptReference,postedCashDecision.receiverReceiptReference);
 await assert.rejects(physical.review(conn,tenant,owner,actual._id,postedCashDecision,source._id),
  {status:409});
 process.env.CLASSICFIN_INTERBRANCH_CASH_SETTLEMENT='disabled';
 const fxReviewer={id:oid(),role:'Reconciliation Officer',branchId:String(branch._id),
  permissions:permissionsFor('Reconciliation Officer'),allowedModules:['forex'],authVersion:0};
 await core.tenantUserModel(conn).create({_id:fxReviewer.id,name:'Independent Forex reviewer',
  email:'fx-'+nonce+'@example.invalid',passwordHash:'scratch-only',role:fxReviewer.role,
  branchId:fxReviewer.branchId,allowedModules:fxReviewer.allowedModules,
  status:'active',authVersion:0,mfaEnabledAt:new Date()});
 const forex=require('../src/tenant/services/forex.service');
 const proposed=await forex.proposeRate(conn,tenant,owner,{fromCurrency:'USD',toCurrency:'SSP',
  side:'sell',rateDecimal:'130',validHours:24,
  note:'Independently reviewed scratch SSP per USD recipient price'});
 const fxRate=await forex.decideRate(conn,tenant,fxReviewer,proposed._id,decision);
 async function openCurrency(kind,code,currency,balance,operator,reviewer,branchId){
  const actual=await treasury.createAccount(conn,tenant,owner,{kind,code,name:'Actual '+code,
   currency,operatorId:kind==='cash'?operator.id:undefined,isDefault:true},
   {configurationBranchId:String(branchId)});
  const observation=await treasury.requestObservation(conn,tenant,operator,actual._id,{
   kind:'opening',actualBalance:balance,observedAt:new Date(Date.now()-1000).toISOString(),
   evidenceType:kind==='cash'?'cash_count':'transfer_register',
   evidenceReference:'LINK-'+code+'-'+nonce,
   note:'Independently counted '+currency+' operational account opening',
   idempotencyKey:crypto.randomUUID()});
  await treasury.reviewObservation(conn,tenant,reviewer,observation.observation._id,decision);
  if(kind==='cash'){
   const shift=await cash.open(conn,tenant,operator,{currency,openingCash:balance});
   await cash.decideOpening(conn,tenant,reviewer,shift._id,decision);
  }
  return actual;
 }
 const sspDrawer=await openCurrency('cash','REAL_SSP_CASH','SSP','2000.00',teller,owner,branch._id);
 const sspPayable=await openCurrency('transfer_clearing','SSP_PAYABLE','SSP','0',teller,owner,branch._id);
 const usdDrawer=await openCurrency('cash','REAL_USD_CASH','USD','100.00',receivingTeller,manager,destination._id);
 const xOrder=(await transfer.createRequest(conn,tenant,teller,{
  senderName:'Sending Customer',senderPhone:sourceInput.senderPhone,
  receiverName:'Receiving Customer',receiverPhone:sourceInput.receiverPhone,
  currency:'SSP',amount:'650.00',payoutCurrency:'USD',payoutAmount:'5.00',
  fxRateId:String(fxRate._id),transferMethod:'Cash',fee:'0',
  destinationBranchId:String(destination._id),idempotencyKey:crypto.randomUUID()
 })).order;
 assert.equal(String(xOrder.amountMinor),'65000');
 assert.equal(String(xOrder.payoutMinor),'500');
 const collect=(await funded.request(conn,tenant,teller,'money_transfer',xOrder._id,{
  ...input(),collectionAccountId:String(sspDrawer._id),
  clearingAccountId:String(sspPayable._id)})).execution;
 await funded.review(conn,tenant,owner,collect._id,decision);
 assert.equal(await amount(sspDrawer._id),'265000');
 assert.equal(await amount(sspPayable._id),'65000');
 const recoveryBefore=await transfer.branchBalances(conn,tenant,manager);
 const outstanding=recoveryBefore.recovery.items.find(item=>item.sourceId===String(xOrder._id));
 assert(outstanding,'The destination branch must see the collected, still-unpaid source');
 assert.equal(outstanding.senderCollected,'SSP 650.00');
 assert.equal(outstanding.recipientDue,'USD 5.00');
 assert.equal(outstanding.state,'awaiting_recipient');
 const claim=await funded.revealPin(conn,tenant,teller,collect._id);
 const verified=await funded.checkPayout(conn,tenant,receivingTeller,{
  pin:claim.pin,senderPhone:sourceInput.senderPhone,receiverNameCheck:sourceInput.receiverName});
 const rejectedPayout=(await funded.requestPayout(conn,tenant,receivingTeller,{
  ...input(),verificationToken:verified.token,payoutAccountId:String(usdDrawer._id)})).execution;
 assert.equal(await amount(usdDrawer._id),'10000');
 await funded.review(conn,tenant,manager,rejectedPayout._id,{
  decision:'reject',note:'Rejected for independently verified payout review test'});
 const rejectedRecovery=await transfer.branchBalances(conn,tenant,manager);
 const rejectedItem=rejectedRecovery.recovery.items.find(item=>item.sourceId===String(xOrder._id));
 assert(rejectedItem,'Rejected payout must leave the original sender collection outstanding');
 assert.equal(rejectedItem.state,'payout_rejected');
 assert.equal(rejectedItem.needsAttention,true);
 assert.equal(await amount(usdDrawer._id),'10000','Rejected payout cannot debit actual USD cash');
 assert.equal(await amount(sspPayable._id),'65000','Rejected payout cannot release original SSP obligation');
 assert.equal((await core.transferOrderModel(conn).findById(xOrder._id)).status,'collected_manual');
 // Re-check the original bound PIN and receiver identity. Do not create a new
 // sender transfer or recycle the already-consumed verification token.
 const nextVerified=await funded.checkPayout(conn,tenant,receivingTeller,{
  pin:claim.pin,senderPhone:sourceInput.senderPhone,receiverNameCheck:sourceInput.receiverName});
 const pay=(await funded.requestPayout(conn,tenant,receivingTeller,{
  ...input(),verificationToken:nextVerified.token,payoutAccountId:String(usdDrawer._id)})).execution;
 assert.notEqual(String(pay._id),String(rejectedPayout._id));
 assert.equal(await amount(usdDrawer._id),'10000');
 await funded.review(conn,tenant,manager,pay._id,decision);
 assert.equal(await amount(usdDrawer._id),'9500');
 assert.equal(await amount(sspPayable._id),'0');
 assert.equal(await amount(sspDrawer._id),'265000');
 const linked=await require('../src/tenant/settlements/models').models(conn).settlement
  .findOne({sourceId:xOrder._id}).lean();
 assert.equal(linked.status,'posted');
 assert.equal(linked.postingBatchIds.length,3);
 assert.equal(String(linked.destinationPayoutAccountId),String(usdDrawer._id));
 assert.equal((await core.transferOrderModel(conn).findById(xOrder._id)).status,'paid_out_manual');
 await assert.rejects(funded.review(conn,tenant,manager,pay._id,decision),{status:409});
 for(const account of [sspDrawer,sspPayable,usdDrawer])
  await treasury.assertBookIntegrity(conn,null,await treasury.models(conn).account.findById(account._id).lean());
 for(const [site,currency] of [[branch,'SSP'],[destination,'USD']])
  assert.equal((await ledger.trialBalance(conn,{branchId:String(site._id),currency})).balanced,true);
 // Receiving branch sees native USD due and the original SSP collection;
 // neither becomes "settled" simply because the cash payout journal balanced.
 const reviewed=await transfer.branchBalances(conn,tenant,manager);
 const linkedItem=reviewed.reconciliation.items.find(item=>item.sourceId===String(xOrder._id));
 assert(linkedItem,'The receiving branch should see linked-currency payout evidence');
 assert.equal(linkedItem.collection,'SSP 650.00');
 assert.equal(linkedItem.payout,'USD 5.00');
 assert.equal(linkedItem.needsReview,false);
 assert.match(linkedItem.branchState,/remain until independently reconciled/);
 const due=reviewed.rows.find(row=>row.currency==='USD');
 assert(due,'Native USD receivable must appear separately');
 assert.equal(due.receivable,'USD 5.00');
 assert.equal(reviewed.recovery.items.some(item=>item.sourceId===String(xOrder._id)),false,
  'Once recipient is paid, the original must leave the unpaid recovery queue');
 await assert.rejects(transfer.branchBalances(conn,tenant,receivingTeller),{status:403});
 // Real, independently reviewed sender cash refund of another SSP->USD
 // collection, NOT a currency swap, fake provider reversal or voided history.
 process.env.CLASSICFIN_LINKED_CURRENCY_REFUNDS='enabled';
 const refundService=require('../src/tenant/refunds/service');
 await require('../src/tenant/refunds/models').ensure(conn);
 const refundOrder=(await transfer.createRequest(conn,tenant,teller,{
  senderName:'Sending Customer',senderPhone:sourceInput.senderPhone,
  receiverName:'Receiving Customer',receiverPhone:sourceInput.receiverPhone,
  currency:'SSP',amount:'13.00',payoutCurrency:'USD',payoutAmount:'0.10',
  fxRateId:String(fxRate._id),transferMethod:'Cash',fee:'1.00',
  destinationBranchId:String(destination._id),idempotencyKey:crypto.randomUUID()
 })).order;
 assert.equal(String(refundOrder.amountMinor),'1300');
 const actualFee=BigInt(String(refundOrder.feeMinor));
 const cashBeforeRefundCollection=BigInt(await amount(sspDrawer._id));
 const payableBeforeRefundCollection=BigInt(await amount(sspPayable._id));
 const refundCollection=(await funded.request(conn,tenant,teller,'money_transfer',refundOrder._id,{
  ...input(),collectionAccountId:String(sspDrawer._id),
  clearingAccountId:String(sspPayable._id)})).execution;
 await funded.review(conn,tenant,owner,refundCollection._id,decision);
 assert.equal(BigInt(await amount(sspDrawer._id)),cashBeforeRefundCollection+1300n+actualFee);
 assert.equal(BigInt(await amount(sspPayable._id)),payableBeforeRefundCollection+1300n);
 const refundInput=()=>({
  idempotencyKey:crypto.randomUUID(),senderPhone:sourceInput.senderPhone,
  reason:'Original sender confirmed request for full cash refund',
  evidenceReference:'SENDER-DOC-'+nonce
 });
 const rejectedRequest=await refundService.request(conn,tenant,teller,refundOrder._id,refundInput());
 assert.equal(rejectedRequest.refund.status,'pending_review');
 const underReview=await transfer.branchBalances(conn,tenant,owner);
 const refundQueueItem=underReview.recovery.items.find(item=>item.sourceId===String(refundOrder._id));
 assert(refundQueueItem,'A cash refund request must appear in the supervisor queue');
 assert.equal(refundQueueItem.state,'refund_under_review');
 assert.match(refundQueueItem.explanation,/Do not issue a recipient payout/);
 await assert.rejects(refundService.request(conn,tenant,teller,refundOrder._id,refundInput()),{status:409});
 const rejected=await refundService.review(conn,tenant,owner,rejectedRequest.refund._id,{
  decision:'reject',note:'Original customer cash refund evidence not yet sufficient'});
 assert.equal(rejected.refund.status,'rejected');
 assert.equal(BigInt(await amount(sspDrawer._id)),cashBeforeRefundCollection+1300n+actualFee);
 assert.equal(BigInt(await amount(sspPayable._id)),payableBeforeRefundCollection+1300n);
 const request2=await refundService.request(conn,tenant,teller,refundOrder._id,refundInput());
 assert.equal(request2.refund.status,'pending_review');
 const secondKey=request2.refund.idempotencyKey;
 assert.equal((await refundService.request(conn,tenant,teller,refundOrder._id,{
  idempotencyKey:secondKey,senderPhone:sourceInput.senderPhone,
  reason:'Original sender confirmed request for full cash refund',
  evidenceReference:'SENDER-DOC-'+nonce
 })).duplicate,true);
 await assert.rejects(refundService.review(conn,tenant,teller,request2.refund._id,{
  decision:'approve',note:'This self-approved refund must be rejected',
  signedReceiptReference:'SIGNED-SELF-'+nonce,cashHandoverConfirmed:'confirmed'
 }),{status:403});
 const validRefundDecision={
  decision:'approve',note:'Original sender counted and signed for full returned cash and fee',
  signedReceiptReference:'SIGNED-HANDOVER-'+nonce,cashHandoverConfirmed:'confirmed'
 };
 await assert.rejects(refundService.review(conn,tenant,owner,request2.refund._id,
  validRefundDecision,String(xOrder._id)),{status:403},
  'A forged URL must not post a refund belonging to another transfer');
 await assert.rejects(refundService.review(conn,tenant,owner,request2.refund._id,{
  ...validRefundDecision,signedReceiptReference:''
 }),{status:400},'Signed refund receipt evidence cannot be omitted');
 const simultaneousRefunds=await Promise.allSettled([
  refundService.review(conn,tenant,owner,request2.refund._id,validRefundDecision,String(refundOrder._id)),
  refundService.review(conn,tenant,owner,request2.refund._id,validRefundDecision,String(refundOrder._id))
 ]);
 assert.equal(simultaneousRefunds.filter(x=>x.status==='fulfilled').length,1,
  'Concurrent double-clicks may create only one compensating cash movement');
 assert.equal(simultaneousRefunds.filter(x=>x.status==='rejected').length,1);
 const approvedRefund=simultaneousRefunds.find(x=>x.status==='fulfilled').value;
 assert.equal(approvedRefund.refund.status,'posted_refund');
 assert.equal(BigInt(await amount(sspDrawer._id)),cashBeforeRefundCollection,
  'Actual original SSP cashier cash + fee must be returned exactly once');
 assert.equal(BigInt(await amount(sspPayable._id)),payableBeforeRefundCollection,
  'The original SSP recipient payable must be fully reversed');
 const refundSource=await core.transferOrderModel(conn).findById(refundOrder._id).lean();
 assert.equal(refundSource.status,'refunded_manual');
 assert.equal(String(refundSource.manualRefundId),String(request2.refund._id));
 assert.equal((await fundedModels.models(conn).execution.findById(refundCollection._id).select('+pinHash +pinEncrypted').lean()).pinHash,null);
 const refundLinked=await require('../src/tenant/settlements/models').models(conn).settlement
  .findOne({sourceId:refundOrder._id}).lean();
 assert.equal(refundLinked.status,'reversed');
 assert.equal(refundLinked.postingBatchIds.length,2);
 const returnedReceipt=await require('../src/tenant/settlements/models').models(conn).event
  .findOne({settlementId:refundLinked._id,stage:'reversed'}).lean();
 assert.equal(returnedReceipt.evidenceSource,'signed_receipt');
 assert.equal((await refundService.detail(conn,tenant,owner,refundOrder._id))[0].status,'posted_refund');
 await assert.rejects(refundService.review(conn,tenant,owner,request2.refund._id,{
  decision:'approve',note:'Trying to return collected money a second time',
  signedReceiptReference:'SIGNED-SECOND-'+nonce,cashHandoverConfirmed:'confirmed'
 }),{status:409});
 assert.equal((await transfer.branchBalances(conn,tenant,manager)).recovery.items
  .some(item=>item.sourceId===String(refundOrder._id)),false);
 await assert.rejects(refundService.request(conn,tenant,teller,xOrder._id,refundInput()),
  {status:409},'Never refund an already-paid original sender');
 assert.equal((await treasury.models(conn).batch.countDocuments({
  sourceType:'money_transfer',sourceRef:'MT-REFUND:'+String(refundOrder._id)
 })),1,'Exactly one posted compensation batch per original cash collection');
 await treasury.assertBookIntegrity(conn,null,await treasury.models(conn).account.findById(sspDrawer._id).lean());
 await treasury.assertBookIntegrity(conn,null,await treasury.models(conn).account.findById(sspPayable._id).lean());
 assert.equal((await ledger.trialBalance(conn,{branchId:String(branch._id),currency:'SSP'})).balanced,true);
 process.env.CLASSICFIN_LINKED_CURRENCY_REFUNDS='disabled';

 process.env.CLASSICFIN_LINKED_CURRENCY_POSTING='disabled';

 console.log('PASS: real SSP sender to USD receiver cross-branch payout with linked journals; destination-bound branch PINs, real destination cash, balanced interbranch receivable/payable journals, revoked sender, rollback, concurrent single payout, branch isolation and book integrity. No live SMS sent.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_branch_transfer_[a-f0-9]{16}$/.test(platformName)){if(conn?.name===require('../src/config/tenantDatabaseName').tenantDbNameFromSlug(slug))await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('BRANCH TRANSFER INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Transfer SMS scratch cleanup failed:',error.message);process.exitCode=1;}));
