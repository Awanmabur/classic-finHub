#!/usr/bin/env node
'use strict';
// Real fund controls in random disposable databases on the local replica set.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Treasury integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(7).toString('hex'),platformName=`cfh_treasury_probe_${nonce}`,slugs=[`treasury-a-${nonce}`,`treasury-b-${nonce}`];
configured.pathname='/'+platformName;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose'),{connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const core=require('../src/tenant/models'),Tenant=require('../src/platform/models/Tenant'),commerce=require('../src/platform/services/commercial.service');
const treasury=require('../src/tenant/treasury/service'),book=require('../src/tenant/treasury/models'),cash=require('../src/tenant/services/cashDrawer.service'),ledger=require('../src/tenant/services/ledger.service');
const {permissionsFor}=require('../src/config/roles');let connections=[];
const id=()=>String(new mongoose.Types.ObjectId()),owner={id:id(),name:'Treasury Owner',role:'Tenant Owner',permissions:['*'],authVersion:0},operator={id:id(),name:'Wallet Operator',role:'Mobile Money Operator',permissions:permissionsFor('Mobile Money Operator'),authVersion:0,allowedModules:['mobile_money','expenses']},reviewer={id:id(),name:'Independent Reviewer',role:'Reconciliation Officer',permissions:permissionsFor('Reconciliation Officer'),authVersion:0,allowedModules:['mobile_money','money_transfer','banking','forex','expenses']};
const requestedAt=new Date(Date.now()-60000).toISOString();
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Tenant.createIndexes();connections=slugs.map(getTenantConnection);for(const conn of connections){await core.ensureTenantIndexes(conn);await book.ensure(conn);}
 const [conn,other]=connections,modules=['mobile_money','money_transfer','banking','forex','expenses'];
 const terms=commerce.planSnapshot({...commerce.asPlanVersion({...require('../src/data/store').plans.find(p=>p.code==='enterprise'),code:'treasury_probe',modules}),status:'published'}),tenants=[];
 for(let i=0;i<2;i++){const slug=slugs[i];tenants.push(await Tenant.create({name:'Treasury isolated proof',slug,dbName:require('../src/config/tenantDatabaseName').tenantDbNameFromSlug(slug),owner:'Proof owner',email:`treasury-${i}-${nonce}@example.invalid`,plan:'treasury_probe',status:'active',setupStatus:'complete',enabledModules:modules,seatsReserved:3,branchCount:1,subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-86400000),periodEnd:new Date(Date.now()+86400000)}}));}
 const [tenant,otherTenant]=tenants,branch=await core.branchModel(conn).create({code:'main',name:'Actual operating branch',currency:'UGX',createdBy:owner.id,updatedBy:owner.id}),otherBranch=await core.branchModel(other).create({code:'main',name:'Other isolated branch',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
 for(const actor of [owner,operator,reviewer]){actor.branchId=String(branch._id);await core.tenantUserModel(conn).create({_id:actor.id,name:actor.name,email:`${actor.id}@example.invalid`,passwordHash:'isolated-proof-only',role:actor.role,branchId:actor.branchId,allowedModules:actor.allowedModules||modules,status:'active',authVersion:0,...(actor.role==='Mobile Money Operator'?{}:{mfaEnabledAt:new Date()})});}
 await core.tenantUserModel(other).create({_id:owner.id,name:owner.name,email:`other-${owner.id}@example.invalid`,passwordHash:'isolated-proof-only',role:owner.role,branchId:String(otherBranch._id),allowedModules:modules,status:'active',authVersion:0,mfaEnabledAt:new Date()});
 async function opening(account,amount,actor=operator){const evidenceType=({wallet:'provider_app',cash:'cash_count',bank:'bank_statement',forex_stock:'stock_count',transfer_clearing:'transfer_register'})[account.kind];const input={kind:'opening',actualBalance:amount,observedAt:requestedAt,evidenceType,evidenceReference:`ACTUAL-OPEN-${account.code}`,note:'Actual balance and named source checked directly',idempotencyKey:crypto.randomUUID()};const request=await treasury.requestObservation(conn,tenant,actor,account._id,input);assert.equal((await treasury.requestObservation(conn,tenant,actor,account._id,input)).duplicate,true);await assert.rejects(treasury.reviewObservation(conn,tenant,actor,request.observation._id,{decision:'approve',note:'Attempt to approve own submitted evidence'}),e=>e.status===403);const approved=await treasury.reviewObservation(conn,tenant,reviewer,request.observation._id,{decision:'approve',note:'Independent source and actual balance were checked'});assert.equal(approved.status,'approved');return book.models(conn).account.findById(account._id).lean();}
 const wallet=await treasury.createAccount(conn,tenant,owner,{code:'MTN_ACTUAL',name:'Actual MTN wallet',kind:'wallet',network:'MTN',currency:'UGX',operatorId:operator.id,accountReference:'Agent wallet ending 1234'}),drawer=await treasury.createAccount(conn,tenant,owner,{code:'CASH_ACTUAL',name:'Actual operator drawer',kind:'cash',currency:'UGX',operatorId:operator.id});
 assert.equal(wallet.openingBalanceMinor,null);assert.equal(await core.ledgerPostingModel(conn).countDocuments(),0,'configuration cannot mint funds');
 const auth=()=>({tenant,actor:operator});async function post(input,actor=operator,authorization=null){const session=await conn.startSession();try{let result;await session.withTransaction(async()=>{result=await treasury.applyMovements(conn,session,authorization||{tenant,actor},{branchId:String(branch._id),sourceType:'mobile_money',description:'Manual cash and wallet operation from actual evidence',...input});});return result;}finally{await session.endSession();}}
 await assert.rejects(post({sourceRef:'UNOPENED-REFERENCE',legs:[{accountId:wallet._id,deltaMinor:'-1'},{accountId:drawer._id,deltaMinor:'1'}]}),e=>e.status===409);
 await opening(wallet,'10000');await opening(drawer,'1000');
 const shift=await cash.open(conn,tenant,operator,{openingCash:'1000'});await cash.decideOpening(conn,tenant,reviewer,shift._id,{decision:'approve',note:'Independent opening drawer count was checked'});
 // Direct funds: existing verified assets move in ONE Mongo transaction,
 // without a second human decision or a new source of spendable money.
 const funding=require('../src/tenant/treasury/funding.service');
 const directSource=await treasury.createAccount(conn,tenant,owner,
  {code:'DIRECT_SRC',name:'Verified source wallet',kind:'wallet',network:'MTN',currency:'UGX',
   operatorId:operator.id,isDefault:false,accountReference:'Existing verified source wallet'});
 const directDest=await treasury.createAccount(conn,tenant,owner,
  {code:'DIRECT_DST',name:'Verified destination wallet',kind:'wallet',network:'MTN',currency:'UGX',
   operatorId:operator.id,isDefault:false,accountReference:'Existing verified destination wallet'});
 await opening(directSource,'2500');await opening(directDest,'100');
 const directInput={sourceAccountId:String(directSource._id),destinationAccountId:String(directDest._id),
  amount:'500',idempotencyKey:crypto.randomUUID()};
 const firstDirect=await funding.postDirect(conn,tenant,operator,directInput);
 assert.equal(firstDirect.funding.status,'posted');
 assert.match(firstDirect.funding.evidenceReference,/^INTERNAL-[0-9a-f-]{36}$/);
 assert.equal(firstDirect.funding.note,'Internal transfer of existing verified account funds');
 assert.equal(firstDirect.duplicate,false);
 assert(firstDirect.funding.batchId,'Atomically posted transfer must have a funds movement batch');
 assert.equal((await funding.postDirect(conn,tenant,operator,directInput)).duplicate,true);
 assert.equal(String((await book.models(conn).account.findById(directSource._id)).bookBalanceMinor),'2000');
 assert.equal(String((await book.models(conn).account.findById(directDest._id)).bookBalanceMinor),'600');
 assert.equal(await require('../src/tenant/treasury/funding.models').model(conn).countDocuments({idempotencyKey:directInput.idempotencyKey}),1);
 await assert.rejects(funding.postDirect(conn,tenant,operator,{...directInput,amount:'550'}),e=>e.status===409);
 await assert.rejects(funding.postDirect(conn,tenant,operator,{...directInput,amount:'8000',
  idempotencyKey:crypto.randomUUID()}),e=>e.status===409);
 assert.equal(String((await book.models(conn).account.findById(directSource._id)).bookBalanceMinor),'2000');
 assert.equal(String((await book.models(conn).account.findById(directDest._id)).bookBalanceMinor),'600');
 const races=await Promise.allSettled([1,2].map(n=>funding.postDirect(conn,tenant,operator,
  {...directInput,amount:'1800',evidenceReference:'DIRECT-RACE-00'+n,
   idempotencyKey:crypto.randomUUID()})));
 assert.equal(races.filter(r=>r.status==='fulfilled').length,1,
  'Simultaneous large internal transfers cannot spend the same funds twice');
 const finalSource=BigInt(String((await book.models(conn).account.findById(directSource._id)).bookBalanceMinor));
 const finalDest=BigInt(String((await book.models(conn).account.findById(directDest._id)).bookBalanceMinor));
 assert.equal(finalSource+finalDest,2600n,'Internal transfers must conserve both account balances');
 assert(finalSource>=0n,'No negative money can be created');
 const input={sourceRef:'MANUAL-MOMO-FIRST',legs:[{accountId:wallet._id,deltaMinor:'-500'},{accountId:drawer._id,deltaMinor:'500'}],evidenceRef:'ACTUAL-NETWORK-1234'};
 const result=await post(input);assert.equal(result.duplicate,false);assert.equal((await post(input)).duplicate,true);assert.equal(await book.models(conn).movement.countDocuments({batchId:result.batch._id}),2);
 assert.equal(String((await book.models(conn).account.findById(wallet._id)).bookBalanceMinor),'9500');assert.equal(String((await book.models(conn).account.findById(drawer._id)).bookBalanceMinor),'1500');assert.equal(String((await core.cashSessionModel(conn).findById(shift._id)).provisionalMovementMinor),'500','binding cannot count opening or movement twice');
 await assert.rejects(post({...input,legs:[{accountId:wallet._id,deltaMinor:'-700'},{accountId:drawer._id,deltaMinor:'700'}]}),e=>e.status===409);
 const journalCount=await core.ledgerJournalModel(conn).countDocuments(),movementCount=await book.models(conn).movement.countDocuments();
 await assert.rejects(post({sourceRef:'INSUFFICIENT-FLOAT',legs:[{accountId:wallet._id,deltaMinor:'-20000'},{accountId:drawer._id,deltaMinor:'20000'}]}),e=>e.status===409&&/Insufficient/.test(e.message));
 await assert.rejects(post({sourceRef:'UNBALANCED-BOOK-123',legs:[{accountId:wallet._id,deltaMinor:'-50'},{accountId:drawer._id,deltaMinor:'25'}]}),/balance exactly/);
 assert.equal(await core.ledgerJournalModel(conn).countDocuments(),journalCount);assert.equal(await book.models(conn).movement.countDocuments(),movementCount);assert.equal(String((await core.cashSessionModel(conn).findById(shift._id)).provisionalMovementMinor),'500');
 const mismatch=await treasury.requestObservation(conn,tenant,operator,wallet._id,{kind:'checkpoint',actualBalance:'9400',observedAt:new Date().toISOString(),evidenceType:'provider_app',evidenceReference:'ACTUAL-MISMATCH-1234',note:'Actual network wallet shows a balance difference',idempotencyKey:crypto.randomUUID()});
 assert.equal((await book.models(conn).account.findById(wallet._id)).status,'held');await treasury.reviewObservation(conn,tenant,reviewer,mismatch.observation._id,{decision:'approve',note:'Independent provider evidence confirms the discrepancy'});
 await assert.rejects(post({sourceRef:'BLOCKED-MISMATCH-123',legs:[{accountId:wallet._id,deltaMinor:'-1'},{accountId:drawer._id,deltaMinor:'1'}]}),e=>e.status===409);
 const adjustment=await treasury.requestAdjustment(conn,tenant,operator,mismatch.observation._id,{reason:'Investigated missing source evidence and requested an explicit suspense adjustment',idempotencyKey:crypto.randomUUID()});await treasury.reviewAdjustment(conn,tenant,reviewer,adjustment.adjustment._id,{decision:'approve',note:'Independent reconciliation proof supports this visible suspense adjustment'});
 const adjusted=await book.models(conn).account.findById(wallet._id).lean();assert.equal(String(adjusted.bookBalanceMinor),'9400');assert.equal(String(adjusted.lastVarianceMinor),'0');assert.equal(adjusted.status,'active');
 const historical=await treasury.requestObservation(conn,tenant,operator,wallet._id,{kind:'checkpoint',actualBalance:'9000',observedAt:new Date(Date.now()-30000).toISOString(),evidenceType:'provider_statement',evidenceReference:'OLD-ACTUAL-STATEMENT',note:'Historical statement preserved without replacing later evidence',idempotencyKey:crypto.randomUUID()});assert.equal((await book.models(conn).account.findById(wallet._id)).status,'active','old mismatches cannot invalidate a later confirmed observation');await treasury.reviewObservation(conn,tenant,reviewer,historical.observation._id,{decision:'approve',note:'Historical evidence retained without replacing the newer checkpoint'});assert.equal(String((await book.models(conn).account.findById(wallet._id)).lastObservationId),String(mismatch.observation._id));
 const late=await post({sourceRef:'LATE-MANUAL-MOMO-123',occurredAt:new Date(Date.now()-1000).toISOString(),legs:[{accountId:wallet._id,deltaMinor:'-10'},{accountId:drawer._id,deltaMinor:'10'}]});assert(late.batch);assert.equal((await book.models(conn).account.findById(wallet._id)).reconciliationState,'stale');
 const recheck=await treasury.requestObservation(conn,tenant,operator,wallet._id,{kind:'checkpoint',actualBalance:'9390',observedAt:new Date().toISOString(),evidenceType:'provider_app',evidenceReference:'ACTUAL-RECHECK-1234',note:'Latest actual wallet checked after the late record',idempotencyKey:crypto.randomUUID()});await treasury.reviewObservation(conn,tenant,reviewer,recheck.observation._id,{decision:'approve',note:'Independent latest observation agrees with all ledger movements'});
 await core.tenantUserModel(conn).updateOne({_id:operator.id},{$set:{status:'disabled'},$inc:{authVersion:1}});
 await assert.rejects(post({sourceRef:'DISABLED-MAKER-123',legs:[{accountId:wallet._id,deltaMinor:'-1'},{accountId:drawer._id,deltaMinor:'1'}]}),e=>e.status===403);
 const session=await conn.startSession();let reversal;try{await session.withTransaction(async()=>{reversal=await treasury.reverseMovements(conn,session,{tenant,actor:reviewer},{sourceType:'mobile_money',sourceRef:input.sourceRef,reversalSourceRef:'VOID:MANUAL-MOMO-FIRST',description:'Independent correction of the original invalid manual entry'});});}finally{await session.endSession();}assert(reversal.batch.reversesBatchId);assert.equal(String((await book.models(conn).account.findById(wallet._id)).bookBalanceMinor),'9890');assert.equal(String((await book.models(conn).account.findById(drawer._id)).bookBalanceMinor),'1010');
 await core.tenantUserModel(conn).updateOne({_id:operator.id},{$set:{status:'active'}});operator.authVersion=1;
 const limited=await treasury.createAccount(conn,tenant,owner,{code:'AIRTEL_LIMITED',name:'Actual Airtel limited float',kind:'wallet',network:'Airtel',currency:'UGX',operatorId:operator.id}),bank=await treasury.createAccount(conn,tenant,owner,{code:'BANK_REAL',name:'Actual bank settlement pool',kind:'bank',currency:'UGX'});await opening(limited,'1000');await opening(bank,'0');
 const concurrent=await Promise.allSettled(['A','B'].map(tag=>post({sourceRef:'CONCURRENT-'+tag+'-REFERENCE',legs:[{accountId:limited._id,deltaMinor:'-600'},{accountId:bank._id,deltaMinor:'600'}]})));assert.equal(concurrent.filter(row=>row.status==='fulfilled').length,1);assert.equal(concurrent.filter(row=>row.status==='rejected').length,1);assert.equal(String((await book.models(conn).account.findById(limited._id)).bookBalanceMinor),'400');assert.equal(String((await book.models(conn).account.findById(bank._id)).bookBalanceMinor),'600');
 const snapshots=await Promise.all(Array.from({length:3},()=>treasury.balanceSnapshot(conn,tenant,owner)));assert(snapshots.every(value=>value.accounts.length>=4));
 const Audit=core.auditEventModel(conn),original=Audit.create,balanceBefore=String((await book.models(conn).account.findById(limited._id)).bookBalanceMinor),countBefore=await core.ledgerJournalModel(conn).countDocuments();Audit.create=async function(documents,options){if(documents.some(document=>document.action==='treasury.movements.posted'))throw Error('Deliberate treasury audit rollback');return original.call(this,documents,options);};try{await assert.rejects(post({sourceRef:'AUDIT-ROLLBACK-REFERENCE',legs:[{accountId:limited._id,deltaMinor:'-1'},{accountId:bank._id,deltaMinor:'1'}]}),/Deliberate treasury audit rollback/);}finally{Audit.create=original;}assert.equal(String((await book.models(conn).account.findById(limited._id)).bookBalanceMinor),balanceBefore);assert.equal(await core.ledgerJournalModel(conn).countDocuments(),countBefore);
 // A reviewed shortage after a CLOSED day must remain resolvable without
 // opening a false new drawer merely to permit the adjustment.
 const closing=await cash.submit(conn,tenant,operator,shift._id,{countedCash:'1000',note:'Actual closing count is ten shillings below the expected book'});assert.equal(String(closing.varianceMinor),'-10');
 const closed=await cash.decide(conn,tenant,reviewer,shift._id,{decision:'approve',note:'Independent physical count confirms the closing shortage'});assert.equal(closed.status,'approved');assert(closed.treasuryObservationId);assert.equal((await book.models(conn).account.findById(drawer._id)).status,'held');
 await assert.rejects(cash.open(conn,tenant,operator,{openingCash:'1000'}),e=>e.status===409,'an unresolved shortage must not become a false new opening');
 const cashAdjustment=await treasury.requestAdjustment(conn,tenant,operator,closed.treasuryObservationId,{reason:'Investigated physical cash shortage and retained supporting closing evidence',idempotencyKey:crypto.randomUUID()});
 await treasury.reviewAdjustment(conn,tenant,reviewer,cashAdjustment.adjustment._id,{decision:'approve',note:'Independent closing evidence supports the visible cash reconciliation suspense entry'});
 const correctedCash=await book.models(conn).account.findById(drawer._id).lean();assert.equal(String(correctedCash.bookBalanceMinor),'1000');assert.equal(correctedCash.status,'active');assert.equal(await core.cashSessionModel(conn).countDocuments({operatorId:operator.id,status:'open'}),0);
 const newDay=await cash.open(conn,tenant,operator,{openingCash:'1000'});await cash.decideOpening(conn,tenant,reviewer,newDay._id,{decision:'approve',note:'Independent next-day opening count agrees with the corrected funds book'});assert.equal(String((await book.models(conn).account.findById(drawer._id)).bookBalanceMinor),'1000','a new day never credits the opening twice');
 await assert.rejects(treasury.accountDetail(other,tenant,owner,wallet._id),e=>e.status===403);await assert.rejects(treasury.accountDetail(other,otherTenant,{...owner,branchId:String(otherBranch._id)},wallet._id),e=>e.status===404);
 for(const journal of await core.ledgerJournalModel(conn).find({}).lean())assert.equal((await ledger.inspectJournal(conn,journal._id)).valid,true);
 assert.equal((await ledger.trialBalance(conn,{branchId:String(branch._id),currency:'UGX'})).balanced,true);
 const snapshot=await treasury.balanceSnapshot(conn,tenant,owner);assert(snapshot.accounts.every(account=>account.actualIsLive===false));assert.equal(snapshot.accounts.find(account=>String(account._id)===String(wallet._id)).expectedMinor,'9890');
 const movement=await book.models(conn).movement.findOne().lean();await assert.rejects(book.models(conn).movement.updateOne({_id:movement._id},{$set:{deltaMinor:'999'}}),/append-only/);
 // A tenant owner can confirm the first PHYSICAL CASH opening with one
 // explicit attestation. Request, audit, balanced journal and existing routine
 // reviewer permission must all succeed in ONE database transaction.
 const starterCash=await treasury.createAccount(conn,tenant,owner,{
  code:'OWNER_QUICK_CASH',name:'Owner counted starting drawer',kind:'cash',currency:'UGX',
  operatorId:owner.id,isDefault:false});
 const firstCapital={amount:'80',idempotencyKey:crypto.randomUUID()};
 await assert.rejects(treasury.addCapital(conn,tenant,owner,starterCash._id,firstCapital),
  e=>e.status===409,'New capital cannot bypass a verified account opening');
 const openingInput={actualBalance:'150',idempotencyKey:crypto.randomUUID()};
 await assert.rejects(treasury.confirmOwnerOpening(conn,tenant,operator,starterCash._id,openingInput),
  e=>e.status===403,'An operator must never self-approve initial funds');
 await assert.rejects(treasury.confirmOwnerOpening(conn,tenant,owner,starterCash._id,
  {...openingInput,actualBalance:'150.30'}),e=>e.status===400);
 const journalsBefore=await core.ledgerJournalModel(conn).countDocuments();
 const quickOpened=await treasury.confirmOwnerOpening(conn,tenant,owner,starterCash._id,openingInput);
 assert.equal(quickOpened.duplicate,false);
 const confirmed=await book.models(conn).account.findById(starterCash._id).lean();
 assert.equal(confirmed.status,'active');
 assert.equal(String(confirmed.bookBalanceMinor),'150');
 assert.equal(String(confirmed.openingBalanceMinor),'150');
 assert(confirmed.openingApprovedAt);
 assert.equal(confirmed.reconciliationState,'matched');
 assert.equal((await treasury.confirmOwnerOpening(conn,tenant,owner,starterCash._id,openingInput)).duplicate,true);
 assert.equal(await core.ledgerJournalModel(conn).countDocuments(),journalsBefore+1,
  'A retry must not post the owner-attested opening equity twice');
 await assert.rejects(treasury.confirmOwnerOpening(conn,tenant,owner,starterCash._id,
  {...openingInput,actualBalance:'200'}),e=>e.status===409);
 await assert.rejects(treasury.confirmOwnerOpening(conn,tenant,owner,starterCash._id,
  {...openingInput,idempotencyKey:crypto.randomUUID()}),e=>e.status===409);
 assert.equal(String((await book.models(conn).account.findById(starterCash._id)).bookBalanceMinor),'150');
 await assert.rejects(treasury.addCapital(conn,tenant,operator,starterCash._id,firstCapital),
  e=>e.status===403,'Ordinary staff cannot create owner capital');
 await assert.rejects(treasury.addCapital(conn,tenant,owner,starterCash._id,{...firstCapital,amount:'0'}),
  e=>e.status===400,'Zero top-up cannot post');
 await assert.rejects(treasury.addCapital(conn,tenant,owner,starterCash._id,{...firstCapital,amount:'-1'}),
  e=>e.status===400,'Negative capital cannot post');
 const capitalBefore=await core.ledgerJournalModel(conn).countDocuments();
 const added=await treasury.addCapital(conn,tenant,owner,starterCash._id,firstCapital);
 assert.equal(added.duplicate,false);
 assert.equal(added.currency,'UGX');
 assert.equal(added.batch.evidenceReference,'CAPITAL-'+firstCapital.idempotencyKey,'Server generates internal audit reference');
 assert(!('evidenceReference' in firstCapital)&&!('confirmed' in firstCapital),'Top-up takes only amount and account');
 assert.equal(String((await book.models(conn).account.findById(starterCash._id)).bookBalanceMinor),'230');
 assert.equal((await treasury.addCapital(conn,tenant,owner,starterCash._id,firstCapital)).duplicate,true,
  'Retrying the same receipt does not add funds twice');
 assert.equal(await core.ledgerJournalModel(conn).countDocuments(),capitalBefore+1,
  'One capital receipt generates exactly one balanced ledger journal');
 // The owner's physically matched cash shifts now open and finish in one
 // submission each, using the existing persisted owner reviewer fence.
 // No cash is invented and no discrepancy can be silently approved.
 const ownerShift=await cash.startOwnerMatchedShift(conn,tenant,owner,{
  currency:'UGX',openingFromBook:'on',physicalCountConfirmed:'on'
 });
 assert.equal(ownerShift.status,'open');
 assert.equal(String(ownerShift.openingMinor),'230');
 const ownerClosed=await cash.finishOwnerMatchedShift(conn,tenant,owner,ownerShift._id,{
  closingFromBook:'on',physicalCountConfirmed:'on'
 });
 assert.equal(ownerClosed.status,'approved');
 assert.equal(String(ownerClosed.varianceMinor),'0');
 // Two owner cash drawers may share a currency. A shift must bind to the
 // drawer selected on screen, not silently take another default's balance.
 const chosenDrawer=await treasury.createAccount(conn,tenant,owner,{
  name:'Owner second UGX physical cash drawer',kind:'cash',currency:'UGX',
  operatorId:owner.id,isDefault:false
 });
 await treasury.confirmOwnerOpening(conn,tenant,owner,chosenDrawer._id,{
  actualBalance:'30',idempotencyKey:crypto.randomUUID()
 });
 const selectedShift=await cash.startOwnerMatchedShift(conn,tenant,owner,{
  currency:'UGX',treasuryAccountId:String(chosenDrawer._id),
  openingFromBook:'on',physicalCountConfirmed:'on'
 });
 assert.equal(String(selectedShift.treasuryAccountId),String(chosenDrawer._id));
 assert.equal(String(selectedShift.openingMinor),'30');
 assert.equal((await cash.finishOwnerMatchedShift(conn,tenant,owner,selectedShift._id,{
  closingFromBook:'on',physicalCountConfirmed:'on'
 })).status,'approved');
 const staffDrawer=await treasury.createAccount(conn,tenant,owner,{
  name:'Another operator UGX cash drawer',kind:'cash',currency:'UGX',
  operatorId:operator.id,isDefault:false
 });
 await treasury.confirmOwnerOpening(conn,tenant,owner,staffDrawer._id,{
  actualBalance:'10',idempotencyKey:crypto.randomUUID()
 });
 await assert.rejects(cash.startOwnerMatchedShift(conn,tenant,owner,{
  currency:'UGX',treasuryAccountId:String(staffDrawer._id),
  openingFromBook:'on',physicalCountConfirmed:'on'
 }),e=>e.status===403,'Owner may not bind their shift to a staff member drawer');

 assert.equal(String((await book.models(conn).account.findById(starterCash._id)).bookBalanceMinor),'230',
  'Cash shift verification cannot create or remove money');
 await assert.rejects(cash.finishOwnerMatchedShift(conn,tenant,operator,ownerShift._id,{
  closingFromBook:'on',physicalCountConfirmed:'on'
 }),e=>e.status===403,'Staff must never use owner one-step closing');
 const beforeRename=await book.models(conn).account.findById(starterCash._id).lean();
 const postingsBeforeRename=await core.ledgerPostingModel(conn).countDocuments();
 const renamed=await treasury.renameAccount(conn,tenant,owner,starterCash._id,{
  name:'Owner front-counter cash UGX'
 });
 assert.equal(renamed.name,'Owner front-counter cash UGX');
 assert.equal(String(renamed.ledgerAccountId),String(beforeRename.ledgerAccountId));
 assert.equal(String(renamed.bookBalanceMinor),String(beforeRename.bookBalanceMinor));
 assert.equal(renamed.selectionKey,beforeRename.selectionKey);
 assert.equal(renamed.feeTreatment,beforeRename.feeTreatment);
 assert.equal(await core.ledgerPostingModel(conn).countDocuments(),postingsBeforeRename,
  'Renaming cannot post financial entries or alter journal history');


 await assert.rejects(treasury.addCapital(conn,tenant,owner,starterCash._id,
  {...firstCapital,amount:'200'}),e=>e.status===409,'A UUID cannot be reused for a different amount');
 // A fresh submission is a new capital declaration. It must never
 // claim to have verified receipt through an external payment provider.
 const ownerBank=await treasury.createAccount(conn,tenant,owner,{code:'OWNER_CAPITAL_BANK',name:'Owner new capital bank',kind:'bank',currency:'UGX',isDefault:false});
 const bankOpening=await treasury.confirmOwnerOpening(conn,tenant,owner,ownerBank._id,
   {actualBalance:'0',idempotencyKey:crypto.randomUUID()});
 assert.equal(bankOpening.observation.status,'approved');
 const bankCapital=await treasury.addCapital(conn,tenant,owner,ownerBank._id,
   {amount:'45',idempotencyKey:crypto.randomUUID()});
 assert.equal(bankCapital.duplicate,false);
 assert.equal(String((await book.models(conn).account.findById(ownerBank._id)).bookBalanceMinor),'45');
 const contribution=await book.models(conn).counter.findOne({branchId:branch._id,currency:'UGX',purpose:'capital_contribution'}).lean();
 assert(contribution,'Separate capital equity chart must exist');
 assert.equal((await core.ledgerAccountModel(conn).findById(contribution.ledgerAccountId).lean()).category,'equity');
 assert.equal((await book.models(conn).batch.countDocuments({sourceType:'treasury_capital'})),2);
 assert.equal((await ledger.trialBalance(conn,{branchId:String(branch._id),currency:'UGX'})).balanced,true);
 // A direct owner check is final immediately without a second reviewer.
 const countKey=crypto.randomUUID();
 const checked=await treasury.recordOwnerBalanceCheck(conn,tenant,owner,ownerBank._id,{
   actualBalance:'45',idempotencyKey:countKey});
 assert.equal(checked.matched,true);
 assert.equal(checked.observation.status,'approved');
 assert.equal((await treasury.recordOwnerBalanceCheck(conn,tenant,owner,ownerBank._id,{
   actualBalance:'45',idempotencyKey:countKey})).duplicate,true);
 await assert.rejects(treasury.recordOwnerBalanceCheck(conn,tenant,operator,ownerBank._id,{
   actualBalance:'45',idempotencyKey:crypto.randomUUID()}),e=>e.status===403);
 await assert.rejects(treasury.recordOwnerBalanceCheck(conn,tenant,owner,ownerBank._id,{
   actualBalance:'47.10',idempotencyKey:crypto.randomUUID()}),e=>e.status===400,
   'UGX amount must be a whole number');
 // Same owner process works per-currency without converting into UGX.
 for(const [currency,amount,minor] of [['USD','12.34','1234'],['SSP','101.25','10125'],['KES','250.75','25075']]){
   const account=await treasury.createAccount(conn,tenant,owner,{
     name:'Capital bank '+currency,kind:'bank',currency,isDefault:false});
   const opened=await treasury.confirmOwnerOpening(conn,tenant,owner,account._id,{
     actualBalance:'0',idempotencyKey:crypto.randomUUID()});
   assert.equal(opened.observation.status,'approved');
   const capital=await treasury.addCapital(conn,tenant,owner,account._id,{
     amount,idempotencyKey:crypto.randomUUID()});
   assert.equal(capital.currency,currency);
   assert.equal(String((await book.models(conn).account.findById(account._id)).bookBalanceMinor),minor);
   const actual=await treasury.recordOwnerBalanceCheck(conn,tenant,owner,account._id,{
     actualBalance:amount,idempotencyKey:crypto.randomUUID()});
   assert.equal(actual.matched,true);
   assert.equal(actual.observation.status,'approved');
   assert.equal((await ledger.trialBalance(conn,{branchId:String(branch._id),currency})).balanced,true);
 }
 const directOwnerMismatch=await treasury.recordOwnerBalanceCheck(conn,tenant,owner,ownerBank._id,{
   actualBalance:'46',idempotencyKey:crypto.randomUUID()});
 assert.equal(directOwnerMismatch.matched,false);
 assert.equal(directOwnerMismatch.observation.status,'approved','Owner count must finish immediately');
 assert.equal(String((await book.models(conn).account.findById(ownerBank._id)).bookBalanceMinor),'45',
   'A counted difference must never rewrite the ledger');
 assert.equal((await book.models(conn).account.findById(ownerBank._id)).status,'held');
 // Recording newly received owner capital is not an adjustment. A held
 // account can receive genuine new money without clearing the old mismatch.
 const heldKey=crypto.randomUUID();
 const heldCapital=await treasury.addCapital(conn,tenant,owner,ownerBank._id,{
   amount:'5',idempotencyKey:heldKey});
 assert.equal(heldCapital.holdPreserved,true);
 assert.equal(heldCapital.duplicate,false);
 assert.equal((await treasury.addCapital(conn,tenant,owner,ownerBank._id,{
   amount:'5',idempotencyKey:heldKey})).duplicate,true);
 const heldBank=await book.models(conn).account.findById(ownerBank._id).lean();
 assert.equal(String(heldBank.bookBalanceMinor),'50','Real new capital must increase the held book');
 assert.equal(heldBank.status,'held','Capital must never release an observed mismatch');
 assert.equal(heldBank.reconciliationState,'mismatch');
 assert.equal(String(heldBank.lastObservedMinor),'46','The original count remains auditable');
 assert.equal((await ledger.trialBalance(conn,{branchId:String(branch._id),currency:'UGX'})).balanced,true);
 // SSP cash with an observed shortage follows the same flow, in its own
 // precision and without creating spendable funds or falsifying the count.
 const heldCash=await treasury.createAccount(conn,tenant,owner,{
   name:'Owner held SSP cash',kind:'cash',currency:'SSP',operatorId:owner.id,isDefault:false});
 await treasury.confirmOwnerOpening(conn,tenant,owner,heldCash._id,{
   actualBalance:'30.00',idempotencyKey:crypto.randomUUID()});
 const shortage=await treasury.recordOwnerBalanceCheck(conn,tenant,owner,heldCash._id,{
   actualBalance:'3.00',idempotencyKey:crypto.randomUUID()});
 assert.equal(shortage.matched,false);
 const sspCapital=await treasury.addCapital(conn,tenant,owner,heldCash._id,{
   amount:'5.50',idempotencyKey:crypto.randomUUID()});
 assert.equal(sspCapital.currency,'SSP');
 assert.equal(sspCapital.holdPreserved,true);
 const sspCash=await book.models(conn).account.findById(heldCash._id).lean();
 assert.equal(String(sspCash.bookBalanceMinor),'3550');
 assert.equal(String(sspCash.lastObservedMinor),'300');
 assert.equal(sspCash.status,'held');
 assert.equal(sspCash.reconciliationState,'mismatch');
 assert.equal((await ledger.trialBalance(conn,{branchId:String(branch._id),currency:'SSP'})).balanced,true);
 await assert.rejects(treasury.addCapital(conn,tenant,operator,heldCash._id,{
   amount:'1',idempotencyKey:crypto.randomUUID()}),e=>e.status===403);

 // Tenant Owner may clean up only MISTAKEN UNUSED setup accounts.
 // This is a reversible status change, never deletion of the ledger mapping.
 for(const [kind,currency] of [['cash','KES'],['bank','USD'],['forex_stock','SSP'],['wallet','UGX']]){
  const draft=await treasury.createAccount(conn,tenant,owner,{
   name:'Unused owner setup '+kind+' '+currency,kind,currency,isDefault:false,
   ...(kind==='cash'?{operatorId:owner.id}:{}),
   ...(kind==='wallet'?{network:'MTN',operatorId:owner.id}:{})
  });
  const ledgerRef=String(draft.ledgerAccountId);
  await assert.rejects(treasury.archiveUnusedAccount(conn,tenant,operator,draft._id,{
   confirmCode:draft.code
  }),e=>e.status===403,'Only owner can archive setup drafts');
  await assert.rejects(treasury.archiveUnusedAccount(conn,tenant,owner,draft._id,{
   confirmCode:'WRONG'
  }),e=>e.status===400,'An incorrect account confirmation must fail');
  const archived=await treasury.archiveUnusedAccount(conn,tenant,owner,draft._id,{
   confirmCode:draft.code
  });
  assert.equal(archived.status,'archived');
  assert.equal(String(archived.ledgerAccountId),ledgerRef,'Archive retains the ledger identity');
  assert.equal(await core.ledgerAccountModel(conn).countDocuments({_id:draft.ledgerAccountId}),1);
  assert.equal((await treasury.restoreArchivedAccount(conn,tenant,owner,draft._id)).status,'uninitialized');
  assert.equal((await treasury.archiveUnusedAccount(conn,tenant,owner,draft._id,{
   confirmCode:draft.code
  })).status,'archived');
 }
 await assert.rejects(treasury.archiveUnusedAccount(conn,tenant,owner,starterCash._id,{
  confirmCode:starterCash.code
 }),e=>e.status===409,'An opened/used account cannot be archived');
 // Standard setup assigns one default per actual account group without
 // preventing the owner from adding a second named wallet in that currency.
 const autoOne=await treasury.createAccount(conn,tenant,owner,{
  name:'Standard primary owner MTN wallet',kind:'wallet',network:'MTN',
  currency:'UGX',operatorId:owner.id,isDefault:'auto'
 });
 const autoTwo=await treasury.createAccount(conn,tenant,owner,{
  name:'Standard secondary owner MTN wallet',kind:'wallet',network:'MTN',
  currency:'UGX',operatorId:owner.id,isDefault:'auto'
 });
 assert(autoOne.selectionKey,'First account in its real wallet group is default');
 assert(!autoTwo.selectionKey,'Second real wallet cannot steal an existing default');
 assert.notEqual(String(autoOne._id),String(autoTwo._id));
 await assert.rejects(treasury.createAccount(conn,tenant,owner,{
  name:'standard secondary owner mtn wallet',kind:'wallet',network:'MTN',
  currency:'UGX',operatorId:owner.id,isDefault:'auto'
 }),e=>e.status===409,'Duplicate group/name is blocked without inventing another account');
 // A previously used, settled wallet can be closed without deleting its history.
 const retiringSource=await treasury.createAccount(conn,tenant,owner,{
  name:'Historical wallet to close',kind:'wallet',network:'MTN',currency:'UGX',
  operatorId:owner.id,isDefault:false
 });
 const retiringDest=await treasury.createAccount(conn,tenant,owner,{
  name:'Replacement wallet',kind:'wallet',network:'MTN',currency:'UGX',
  operatorId:owner.id,isDefault:false
 });
 await treasury.confirmOwnerOpening(conn,tenant,owner,retiringSource._id,{
  actualBalance:'25',idempotencyKey:crypto.randomUUID()
 });
 await treasury.confirmOwnerOpening(conn,tenant,owner,retiringDest._id,{
  actualBalance:'0',idempotencyKey:crypto.randomUUID()
 });
 const retirementFunding=await funding.postDirect(conn,tenant,owner,{
  sourceAccountId:String(retiringSource._id),destinationAccountId:String(retiringDest._id),
  amount:'25',idempotencyKey:crypto.randomUUID()
 });
 const closeReason='Real account replaced after settling all existing funds.';
 await assert.rejects(treasury.closeSettledAccount(conn,tenant,owner,retiringSource._id,{
  confirmCode:retiringSource.code,reason:closeReason
 }),e=>e.status===409,'Zero funds require a fresh actual post-transaction check');
 const checkZero=await treasury.recordOwnerBalanceCheck(conn,tenant,owner,retiringSource._id,{
  actualBalance:'0',idempotencyKey:crypto.randomUUID()
 });
 assert(checkZero.matched);
 const historyCount=await book.models(conn).movement.countDocuments({accountId:retiringSource._id});
 const postedCount=await core.ledgerPostingModel(conn).countDocuments({accountId:retiringSource.ledgerAccountId});
 assert(historyCount>0&&postedCount>0);
 await assert.rejects(treasury.closeSettledAccount(conn,tenant,operator,retiringSource._id,{
  confirmCode:retiringSource.code,reason:closeReason
 }),e=>e.status===403);
 const retired=await treasury.closeSettledAccount(conn,tenant,owner,retiringSource._id,{
  confirmCode:retiringSource.code,reason:closeReason
 });
 assert.equal(retired.status,'archived');
 assert.equal(await book.models(conn).movement.countDocuments({accountId:retiringSource._id}),historyCount);
 assert.equal(await core.ledgerPostingModel(conn).countDocuments({accountId:retiringSource.ledgerAccountId}),postedCount);
 assert.equal((await treasury.accountDetail(conn,tenant,owner,retiringSource._id)).account.status,'archived');
 assert.equal((await require('../src/tenant/treasury/funding.models').model(conn)
  .findById(retirementFunding.funding._id)).status,'posted');
 await assert.rejects(funding.postDirect(conn,tenant,owner,{
  sourceAccountId:String(retiringSource._id),destinationAccountId:String(retiringDest._id),
  amount:'1',idempotencyKey:crypto.randomUUID()
 }),e=>[404,409].includes(e.status),'Closed account cannot fund new operations');
 // A link from a funded wallet is a dependency even without new movements.
 const linkedDraft=await treasury.createAccount(conn,tenant,owner,{
  name:'Unused linked drawer',kind:'cash',currency:'UGX',operatorId:operator.id,isDefault:false
 });
 const W=book.models(conn).account;
 await W.updateOne({_id:wallet._id},{$set:{cashDrawerAccountId:linkedDraft._id}});
 await assert.rejects(treasury.archiveUnusedAccount(conn,tenant,owner,linkedDraft._id,{
  confirmCode:linkedDraft.code
 }),e=>e.status===409,'A drawer assigned to another wallet must not be hidden');
 await W.updateOne({_id:wallet._id},{$set:{cashDrawerAccountId:null}});
 assert.equal((await treasury.archiveUnusedAccount(conn,tenant,owner,linkedDraft._id,{
  confirmCode:linkedDraft.code
 })).status,'archived');
 // A real POST response must reach the existing Treasury endpoint and
 // return the correct AJAX redirect. Previously service-only tests missed
 // production complaints of "Page not found" after balance submissions.
 const express=require('express'),httpApp=express(),httpCsrf=crypto.randomBytes(32).toString('hex');
 httpApp.use(express.urlencoded({extended:false}));
 httpApp.use((req,res,next)=>{
  req.user=owner;req.tenant=tenant;req.tenantDb=conn;req.session={csrfToken:httpCsrf};
  next();
 });
 // Match the production security and AJAX middleware ordering: a real form
 // includes _csrf, which MUST be verified then stripped before the service.
 httpApp.use(require('../src/middleware/csrfProtection'));
 httpApp.use(require('../src/middleware/ajaxRedirect').ajaxRedirect);
 httpApp.use('/tenant/treasury',require('../src/tenant/treasury/routes')({
  renderTenant:(req,res,view)=>res.status(200).json({view})
 }));
 const listener=await new Promise((resolve,reject)=>{
  const server=httpApp.listen(0,'127.0.0.1',()=>resolve(server));
  server.once('error',reject);
 });
 try{
  const base='http://127.0.0.1:'+listener.address().port;
  const submit=async(path,values)=>{
   const response=await fetch(base+path,{method:'POST',redirect:'manual',headers:{
    'Content-Type':'application/x-www-form-urlencoded',
    'X-ClassicFin-Redirect':'json'
   },body:new URLSearchParams({_csrf:httpCsrf,...values})});
   const body=await response.text();
   assert.equal(response.status,200,'Treasury action failed instead of returning AJAX success: '+body.slice(0,400));
   return JSON.parse(body);
  };
  const sspRoute='/tenant/treasury/accounts/'+heldCash._id+'/record';
  const sspPosted=await submit(sspRoute,{
   recordAction:'capital',amount:'1.25',idempotencyKey:crypto.randomUUID()});
  assert.equal(sspPosted.redirect,'/tenant/treasury/accounts/'+heldCash._id+'#record-balance');
  assert.equal(sspPosted.flash.type,'good');
  // A legacy already-open tab still submits "action" and is accepted,
  // but newly loaded HTML sends "recordAction" to avoid DOM action collisions.
  assert.match(sspPosted.flash.message,/still held/);
  const sspDestination=await fetch(base+sspPosted.redirect);
  assert.equal(sspDestination.status,200,'Account destination must exist after successful posting');
  assert.equal((await sspDestination.json()).view,'treasury/detail');
  const updatedSSP=await book.models(conn).account.findById(heldCash._id).lean();
  assert.equal(updatedSSP.status,'held');
  assert.equal(String(updatedSSP.bookBalanceMinor),'3675');
  const ugxRoute='/tenant/treasury/accounts/'+starterCash._id+'/record';
  const ugxPosted=await submit(ugxRoute,{
   action:'capital',amount:'2',idempotencyKey:crypto.randomUUID()});
  assert.equal(ugxPosted.redirect,'/tenant/treasury/accounts/'+starterCash._id+'#record-balance');
  assert.equal((await fetch(base+ugxPosted.redirect)).status,200);
  // Old forms still posted by an already-open browser tab remain functional.
  const legacy=await submit('/tenant/treasury/capital',{
   accountId:String(starterCash._id),amount:'3',idempotencyKey:crypto.randomUUID()});
  assert.equal(legacy.redirect,'/tenant/treasury/accounts/'+starterCash._id+'#record-balance');
  assert.equal((await fetch(base+legacy.redirect)).status,200);
  const unopenedKsh=await treasury.createAccount(conn,tenant,owner,{
   name:'KSH fresh owner cash opening from real HTML form',kind:'cash',currency:'KES',
   operatorId:owner.id,isDefault:false});
  const kshOpening=await submit('/tenant/treasury/accounts/'+unopenedKsh._id+'/opening',{
   actualBalance:'42.35',idempotencyKey:crypto.randomUUID()
  });
  assert.equal(kshOpening.redirect,'/tenant/treasury/accounts/'+unopenedKsh._id);
  assert.equal(kshOpening.flash?.type,'good');
  const liveKsh=await book.models(conn).account.findById(unopenedKsh._id).lean();
  assert.equal(liveKsh.status,'active');
  assert.equal(String(liveKsh.bookBalanceMinor),'4235');
  assert.equal((await fetch(base+kshOpening.redirect)).status,200);
  // Tampered CSRF must be denied by the actual middleware before any write.
  const forged=await fetch(base+'/tenant/treasury/accounts/'+unopenedKsh._id+'/opening',{
   method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams({_csrf:'forged',actualBalance:'500',
    idempotencyKey:crypto.randomUUID()})
  });
  assert.equal(forged.status,403);
  assert.equal(String((await book.models(conn).account.findById(unopenedKsh._id)).bookBalanceMinor),'4235');

 }finally{
  await new Promise(resolve=>listener.close(resolve));
 }
 // First opening correction must append one balanced journal, preserve
 // original opening, and reject staff, reuse and post-transaction tampering.
 const typoBank=await treasury.createAccount(conn,tenant,owner,{
  name:'Unused opening typo correction bank',kind:'bank',currency:'UGX',isDefault:false
 });
 await treasury.confirmOwnerOpening(conn,tenant,owner,typoBank._id,{
  actualBalance:'100',idempotencyKey:crypto.randomUUID()
 });
 const beforeFixJournals=await core.ledgerJournalModel(conn).countDocuments();
 const correctionKey=crypto.randomUUID();
 await assert.rejects(treasury.correctUnusedOpening(conn,tenant,operator,typoBank._id,{
  correctedBalance:'40',confirmed:'on',idempotencyKey:crypto.randomUUID()
 }),e=>e.status===403);
 await assert.rejects(treasury.correctUnusedOpening(conn,tenant,owner,typoBank._id,{
  correctedBalance:'40',idempotencyKey:crypto.randomUUID()
 }),e=>e.status===403);
 const fixed=await treasury.correctUnusedOpening(conn,tenant,owner,typoBank._id,{
  correctedBalance:'40',confirmed:'on',idempotencyKey:correctionKey
 });
 assert.equal(fixed.duplicate,false);
 const actual=await book.models(conn).account.findById(typoBank._id).lean();
 assert.equal(String(actual.openingBalanceMinor),'100','The old opening is immutable');
 assert.equal(String(actual.bookBalanceMinor),'40');
 assert.equal(actual.reconciliationState,'matched');
 assert.equal(actual.status,'active');
 assert.equal(Number(actual.sequence),1);
 assert.equal(await core.ledgerJournalModel(conn).countDocuments(),beforeFixJournals+1);
 assert.equal((await treasury.correctUnusedOpening(conn,tenant,owner,typoBank._id,{
  correctedBalance:'40',confirmed:'on',idempotencyKey:correctionKey
 })).duplicate,true);
 await assert.rejects(treasury.correctUnusedOpening(conn,tenant,owner,typoBank._id,{
  correctedBalance:'45',confirmed:'on',idempotencyKey:crypto.randomUUID()
 }),e=>e.status===409,'Once posted, further corrections require reconciliation');
 assert.equal(String((await book.models(conn).movement.findOne({accountId:typoBank._id})).deltaMinor),'-60');
 assert.equal((await ledger.trialBalance(conn,{branchId:String(branch._id),currency:'UGX'})).balanced,true);
 const heldTypo=await treasury.createAccount(conn,tenant,owner,{
  name:'Unused Held bank opening typo',kind:'bank',currency:'UGX',isDefault:false
 });
 await treasury.confirmOwnerOpening(conn,tenant,owner,heldTypo._id,{
  actualBalance:'50',idempotencyKey:crypto.randomUUID()
 });
 assert.equal((await treasury.recordOwnerBalanceCheck(conn,tenant,owner,heldTypo._id,{
  actualBalance:'35',idempotencyKey:crypto.randomUUID()
 })).matched,false);
 assert.equal((await book.models(conn).account.findById(heldTypo._id)).status,'held');
 await treasury.correctUnusedOpening(conn,tenant,owner,heldTypo._id,{
  correctedBalance:'35',confirmed:'on',idempotencyKey:crypto.randomUUID()
 });
 assert.equal((await book.models(conn).account.findById(heldTypo._id)).status,'active');
 await Tenant.updateOne({_id:tenant._id},{$set:{enabledModules:[]},$inc:{__v:1}});await assert.rejects(treasury.balanceSnapshot(conn,tenant,owner),e=>e.status===403);
 console.log('PASS: Treasury real independent opening evidence, exact posted funds and cash, balanced journals, idempotency, insufficient-float and mismatch holds, dated checkpoints, explicit suspense adjustments, late-entry invalidation, historical-maker correction, concurrent balance guards, audit rollback, append-only history, live revocation and tenant isolation.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_treasury_probe_[a-f0-9]{14}$/.test(platformName)){for(const conn of connections)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('TREASURY INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Treasury scratch cleanup failed:',error.message);process.exitCode=1;}));
