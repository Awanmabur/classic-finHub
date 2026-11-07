'use strict';
// Independently approved MANUAL books. These records never assert that an
// external bank, remittance provider or network executed a payment.
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const models=require('../models');
const {models:fundedModels,ensureIndexes}=require('../funded/models');
const pin=require('../funded/pin');
const Tenant=require('../../platform/models/Tenant');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const {permissionsFor}=require('../../config/roles');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const auth=require('./financialAuthorization.service');
const {resolveTransactionBranch}=require('./transactionBranch.service');
const directory=require('../customerAccounts/models');
const {currencyCodes}=require('../../config/currencies');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OID=/^[a-f0-9]{24}$/i;
const definitions=Object.freeze({
 banking:{model:models.bankingRequestModel,create:'banking.requests.create',review:'banking.review',statuses:['requested','approved_pending_bank'],action:'banking',label:'Banking'},
 forex:{model:models.forexQuoteModel,create:'forex.quotes.create',review:'forex.quotes.review',statuses:['quoted','approved_pending_execution'],action:'forex',label:'Forex'},
 money_transfer:{model:models.transferOrderModel,create:'money_transfer.create',review:'money_transfer.review',statuses:['requested','approved_pending_provider'],action:'transfer_collect',label:'Money Transfer'}
});
const treasury=()=>require('../treasury/service');
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function id(value){if(!OID.test(String(value||'')))throw fail('Invalid financial record identifier');return String(value).toLowerCase();}
function text(value,label,min=0,max=120){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||/[<>\u0000-\u001f\u007f]/.test(value))throw fail(`Invalid ${label}`);return value.trim();}
function hash(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function minor(value,allowZero=false){const s=String(value??'');if(!/^(?:0|[1-9]\d{0,17})$/.test(s)||(!allowZero&&BigInt(s)===0n))throw fail('Stored financial amount is invalid',409);return s;}
function definition(type){if(!Object.hasOwn(definitions,type))throw fail('Unsupported manual financial module');return definitions[type];}
function permission(type,review=false,action=null){if(action==='transfer_payout')return review?'money_transfer.review':'money_transfer.payout';return definition(type)[review?'review':'create'];}
function sourceSnapshot(type,source){
 const base={sourceType:type,sourceId:id(source._id),reference:String(source.reference),branchId:id(source.branchId),createdBy:id(source.createdBy)};
 if(type==='forex'){
  if(!['buy','sell'].includes(source.operation))throw fail('Choose an explicit Buy or Sell quote before recording a manual exchange',409);
  if(!currencyCodes.includes(source.fromCurrency)||!currencyCodes.includes(source.toCurrency)||source.fromCurrency===source.toCurrency)throw fail('Manual books require supported, different currencies',409);
  const fee=require('./operationCapture.service').commissionMinor(source.capture||{},source.toCurrency);
  return {...base,operation:source.operation,fromCurrency:source.fromCurrency,toCurrency:source.toCurrency,sourceMinor:minor(source.sourceMinor),targetMinor:minor(source.targetMinor),feeMinor:String(fee),settlementMethod:source.capture?.settlementMethod||'Cash',rateId:id(source.rateId),rateDecimal:String(source.rateDecimal)};
 }
 if(!currencyCodes.includes(source.currency))throw fail('Unsupported manual financial currency',409);
 if(type==='banking'){
  if(source.source?.referenceType!=='customer_account'||(source.kind==='transfer_request'&&source.destination?.referenceType!=='customer_account'))throw fail('Manual banking posting requires real internal customer accounts. External bank references remain instructions until independently verified.',409);
  return {...base,kind:source.kind,currency:source.currency,amountMinor:minor(source.amountMinor),customerAccountId:id(source.source.referenceId),destinationAccountId:source.destination?id(source.destination.referenceId):null,paymentChannel:source.capture?.paymentChannel||'Cash'};
 }
 return {...base,currency:source.currency,amountMinor:minor(source.amountMinor),feeMinor:minor(source.feeMinor,true),method:source.capture?.method||'Cash',receiverPhone:pin.normalPhone(source.beneficiary.phone),receiverName:String(source.beneficiary.name)};
}
async function context(conn,tenant,actor,type,requiredPermission=null,session=null){
 definition(type);
 if(!tenant?.slug||conn.name!==tenantDbNameFromSlug(tenant.slug))throw fail('Manual financial workspace is invalid',403);
 const tq=Tenant.findOne({_id:id(tenant._id),slug:tenant.slug,dbName:conn.name,status:{$in:['active','trial']}}),uq=models.tenantUserModel(conn).findOne({_id:id(actor?.id),status:'active'});
 if(session){tq.session(session);uq.session(session);}
 const currentTenant=await tq.lean(),person=await uq.lean();
 if(!currentTenant||!person||person.role!==actor.role||(person.authVersion||0)!==(actor.authVersion||0))throw fail('Financial account access changed. Sign in again.',403);
 const trusted=auth.trustedActor(person);
 if(!hasModuleForUser(currentTenant,trusted,type)||!hasPermission(trusted,requiredPermission||`${type}.view`))throw fail('This financial module or operation is unavailable',403);
 if(!['Tenant Owner','Auditor'].includes(trusted.role)&&(!OID.test(String(trusted.branchId||''))||String(trusted.branchId)!==String(actor.branchId||'')))throw fail('Your operating branch changed. Reload before continuing.',403);
 return {tenant:currentTenant,actor:session?trusted:require('./branchView.service').withReadView(trusted,actor)};
}
function scope(actor){return ['Tenant Owner','Auditor'].includes(actor.role)?require('./branchView.service').readScope(actor):{branchId:id(actor.branchId)};}
function readScope(actor){return {...scope(actor),...(['Banking Operator','Forex Operator','Money Transfer Operator'].includes(actor.role)?{createdBy:id(actor.id)}:{})};}
async function audit(conn,session,actor,execution,action,extra={}){await models.auditEventModel(conn).create([{action:`funded.${action}`,actorId:actor.id,targetId:execution._id,metadata:{branchId:String(execution.branchId),sourceType:execution.sourceType,sourceId:String(execution.sourceId),executionAction:execution.action,...extra}}],{session});}
async function prepareIndexes(conn){await Promise.all([models.ensureTenantIndexes(conn),ensureIndexes(conn),directory.ensureIndexes(conn)]);}
async function transaction(conn,work){const session=await conn.startSession();try{let result;await session.withTransaction(async()=>{result=await work(session);});return result;}finally{await session.endSession();}}
function formInput(input={}){if(!UUID.test(String(input.idempotencyKey||'')))throw fail('Reload the form to obtain a new request reference');return {idempotencyKey:input.idempotencyKey,evidenceReference:text(input.evidenceReference,'counted cash / statement reference',5,120),note:text(input.note,'manual movement explanation',12,400)};}
function paymentKind(method){return ['Cash','Cash payment'].includes(method)?'cash':['Mobile Money','Mobile money','Wallet Balance','Wallet balance'].includes(method)?'wallet':'bank';}
function arrayAccounts(result){return Array.isArray(result)?result:(result?.accounts||result?.items||[]);}
async function availableAccounts(conn,tenant,actor,branchId,type){return arrayAccounts(await treasury().findOperatingAccounts(conn,tenant,actor,{branchId:String(branchId),moduleKey:type}));}
function choose(accounts,submitted,{kind,currency,actorId,label}){
 const candidates=accounts.filter(account=>account.kind===kind&&account.currency===currency&&account.status==='active'&&
  (!account.operatorId||String(account.operatorId)===String(actorId))&&
  (kind!=='cash'||String(account.operatorId||'')===String(actorId)));
 let selected;
 if(submitted)selected=candidates.find(account=>String(account._id)===id(submitted));
 else{
  // An assigned balance takes precedence over shared balances. Each network
  // can have a default, so a truthy selectionKey alone cannot identify one
  // unambiguous payment wallet across all networks.
  const assigned=candidates.filter(account=>String(account.operatorId||'')===String(actorId));
  const choices=assigned.length?assigned:candidates;
  const defaults=choices.filter(account=>account.isDefault||account.selectionKey);
  if(defaults.length>1||(!defaults.length&&choices.length>1))throw fail(`Choose the precise ${label||kind} account before posting this movement`,409);
  selected=defaults[0]||(choices.length===1?choices[0]:null);
 }
 if(!selected)throw fail(`Configure and reconcile ${label||kind} in your operating branch before posting this movement`,409);
 return id(selected._id);
}
async function selectedAccounts(conn,authorization,snapshot,input,action){
 const accounts=await availableAccounts(conn,authorization.tenant,authorization.actor,snapshot.branchId,snapshot.sourceType);
 const chooseAccount=(submitted,kind,currency,label)=>choose(accounts,submitted,{kind,currency,actorId:authorization.actor.id,label});
 const result={cashAccountId:null,foreignAccountId:null,settlementAccountId:null,collectionAccountId:null,clearingAccountId:null,payoutAccountId:null};
 if(action==='forex'){
  result.foreignAccountId=chooseAccount(input.foreignAccountId,'forex_stock',snapshot.fromCurrency,`${snapshot.fromCurrency} foreign-currency stock`);
  result.settlementAccountId=chooseAccount(input.settlementAccountId,paymentKind(snapshot.settlementMethod),snapshot.toCurrency,`${snapshot.toCurrency} settlement balance`);
 }else if(action==='banking'&&snapshot.kind!=='transfer_request')result.cashAccountId=chooseAccount(input.cashAccountId,paymentKind(snapshot.paymentChannel),snapshot.currency,'the counted cash or settlement balance');
 else if(action==='transfer_collect'){
  result.collectionAccountId=chooseAccount(input.collectionAccountId,paymentKind(snapshot.method),snapshot.currency,'the collected funds account');
  result.clearingAccountId=chooseAccount(input.clearingAccountId,'transfer_clearing',snapshot.currency,'the transfer funds payable account');
 }
 return result;
}
function assertSourceAvailable(source,type,action){
 if(!source)throw fail('The original instruction is unavailable',404);
 if(action==='transfer_payout'){if(source.status!=='collected_manual')throw fail('Only collected manual transfer funds can enter payout',409);return;}
 if(!definition(type).statuses.includes(source.status))throw fail('This instruction is already posted, cancelled, rejected or unavailable',409);
 if(!(source.expiresAt instanceof Date)||source.expiresAt<=new Date())throw fail('The instruction or quote expired. Create a fresh instruction before accepting funds.',409);
}
async function prepare(conn,tenant,actor,type,sourceId){
 const current=await context(conn,tenant,actor,type,permission(type));await prepareIndexes(conn);
 const source=await definition(type).model(conn).findOne({_id:id(sourceId),...scope(current.actor)}).lean();
 if(!source)throw fail('Financial instruction not found',404);
 if(current.actor.role!=='Tenant Owner'&&String(source.createdBy)!==current.actor.id)throw fail('Only the originator may request this manual posting',403);
 assertSourceAvailable(source,type,definition(type).action);
 const branch=await resolveTransactionBranch(conn,current.actor);if(String(branch._id)!==String(source.branchId))throw fail('The instruction belongs to a different operating branch',403);
 const snapshot=sourceSnapshot(type,source),accounts=await availableAccounts(conn,current.tenant,current.actor,source.branchId,type);
 return {source,snapshot,accounts,type,actor:current.actor,action:definition(type).action,idempotencyKey:crypto.randomUUID()};
}
async function request(conn,tenant,actor,type,sourceId,input={}){
 const v=formInput(input),current=await context(conn,tenant,actor,type,permission(type));await prepareIndexes(conn);
 const branch=await resolveTransactionBranch(conn,current.actor,input),action=definition(type).action;
 const source=await definition(type).model(conn).findOne({_id:id(sourceId),branchId:branch._id}).lean();
 if(!source)throw fail('Financial instruction not found in your operating branch',404);
 if(current.actor.role!=='Tenant Owner'&&String(source.createdBy)!==current.actor.id)throw fail('Only the originator may request this manual posting',403);
 const snapshot=sourceSnapshot(type,source),accounts=await selectedAccounts(conn,current,snapshot,input,action);
 const canonical={sourceType:type,sourceId:id(sourceId),action,branchId:String(branch._id),createdBy:current.actor.id,accounts,...v};
 const fingerprint=hash(canonical),Execution=fundedModels(conn).execution;
 const prior=await Execution.findOne({idempotencyKey:v.idempotencyKey}).lean();
 if(prior){if(prior.fingerprint!==fingerprint)throw fail('Request reference reused with different financial details',409);return {execution:prior,duplicate:true};}
 try{return await transaction(conn,async session=>{
  const authorization=await auth.fenceAction(conn,session,actor,current.tenant,type,permission(type),{branchId:String(branch._id)});
  const fresh=await definition(type).model(conn).findOne({_id:source._id,branchId:branch._id}).session(session).lean();
  assertSourceAvailable(fresh,type,action);if(hash(sourceSnapshot(type,fresh))!==hash(snapshot))throw fail('Instruction economics changed. Reload before recording.',409);
  const [execution]=await Execution.create([{...canonical,sourceReference:fresh.reference,fingerprint,sourceFingerprint:hash(snapshot),sourceSnapshot:snapshot,
   activeKey:`${type}:${fresh._id}:${action}`}],{session});
  await audit(conn,session,authorization.actor,execution,'manual.requested');return {execution,duplicate:false};
 });}catch(error){if(error.code===11000)throw fail('This instruction already has a pending or posted manual movement',409);throw error;}
}
async function lockCustomerAccount(conn,session,authorization,accountId,branchId,currency){
 if(!hasModuleForUser(authorization.tenant,authorization.actor,'accounts')||!hasPermission(authorization.actor,'accounts.view'))throw fail('Customer Accounts access is required for internal banking',403);
 const account=await directory.accountModel(conn).findOneAndUpdate({_id:id(accountId),branchId,currency,status:'active'},{$inc:{revision:1}},{new:true,session}).lean();
 if(!account)throw fail('The internal customer account is not active in this branch and currency',409);
 const customer=await directory.customerModel(conn).findOneAndUpdate({_id:account.customerId,branchId,status:'active'},{$inc:{revision:1}},{new:true,session}).lean();
 if(!customer)throw fail('The customer is no longer active',409);
 const ledger=await models.ledgerAccountModel(conn).findOne({_id:account.ledgerAccountId,branchId,currency,category:'liability'}).session(session).lean();
 if(!ledger)throw fail('Customer liability account mapping is unavailable',409);
 return {account,ledger};
}
async function customerBalance(conn,session,ledgerId,branchId,currency){
 const rows=await models.ledgerPostingModel(conn).aggregate([{$match:{accountId:new mongoose.Types.ObjectId(ledgerId),branchId:new mongoose.Types.ObjectId(branchId),currency}},{$group:{_id:'$side',amount:{$sum:'$amountMinor'}}}]).session(session);
 return rows.reduce((total,row)=>total+(row._id==='credit'?1n:-1n)*BigInt(String(row.amount)),0n);
}
function economicPlan(snapshot,accounts,{sourceLiabilityId=null,destinationLiabilityId=null,feeIncomeId=null}={}){
 const legs=[],ledgerLines=[],amount=BigInt(snapshot.amountMinor||'0'),fee=BigInt(snapshot.feeMinor||'0');
 const leg=(accountId,delta)=>{if(delta!==0n)legs.push({accountId,deltaMinor:String(delta)});};
 const line=(currency,accountId,side,value)=>{if(value!==0n)ledgerLines.push({currency,accountId,side,amountMinor:String(value)});};
 if(snapshot.sourceType==='forex'){
  const foreign=BigInt(snapshot.sourceMinor),settlement=BigInt(snapshot.targetMinor);
  if(fee>=settlement&&snapshot.operation==='buy')throw fail('Commission must be less than the customer settlement amount',409);
  if(snapshot.operation==='buy'){leg(accounts.foreignAccountId,foreign);leg(accounts.settlementAccountId,-(settlement-fee));}
  else{leg(accounts.foreignAccountId,-foreign);leg(accounts.settlementAccountId,settlement+fee);}
  if(fee>0n)line(snapshot.toCurrency,feeIncomeId,'credit',fee);
 }else if(snapshot.sourceType==='banking'){
  if(snapshot.kind==='deposit_request'){leg(accounts.cashAccountId,amount);line(snapshot.currency,sourceLiabilityId,'credit',amount);}
  else if(snapshot.kind==='withdrawal_request'){leg(accounts.cashAccountId,-amount);line(snapshot.currency,sourceLiabilityId,'debit',amount);}
  else{line(snapshot.currency,sourceLiabilityId,'debit',amount);line(snapshot.currency,destinationLiabilityId,'credit',amount);}
 }else{
  leg(accounts.collectionAccountId,amount+fee);leg(accounts.clearingAccountId,amount);if(fee>0n)line(snapshot.currency,feeIncomeId,'credit',fee);
 }
 return {legs,ledgerLines};
}
async function feeAccount(conn,session,authorization,snapshot,execution){
 if(BigInt(snapshot.feeMinor||'0')===0n)return null;
 const result=await treasury().ensureCounterAccount(conn,session,{tenantId:String(authorization.tenant._id),branchId:String(execution.branchId),currency:snapshot.sourceType==='forex'?snapshot.toCurrency:snapshot.currency,purpose:'fee_income',actorId:authorization.actor.id});
 return String(result.ledgerAccountId||result._id);
}
async function review(conn,tenant,actor,executionId,input={}){
 if(!tenant?.slug||conn.name!==tenantDbNameFromSlug(tenant.slug))throw fail('Manual financial workspace is invalid',403);
 if(!['approve','reject'].includes(input.decision))throw fail('Choose approve or reject');const note=text(input.note,'review evidence',12,400);
 await prepareIndexes(conn);const Execution=fundedModels(conn).execution,initial=await Execution.findById(id(executionId)).lean();if(!initial)throw fail('Manual movement not found',404);
 const current=await context(conn,tenant,actor,initial.sourceType,permission(initial.sourceType,true,initial.action));
 if(!['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(current.actor.role))throw fail('Independent financial reviewer required',403);
 if(String(initial.createdBy)===current.actor.id)throw fail('The originator cannot review their own manual movement',403);
 return transaction(conn,async session=>{
  const authorization=await auth.fenceAction(conn,session,actor,current.tenant,initial.sourceType,permission(initial.sourceType,true,initial.action));
  if(!await models.tenantUserModel(conn).exists({_id:actor.id,status:'active',mfaEnabledAt:{$ne:null}}).session(session))throw fail('Authenticator enrollment is required for manual financial review',403);
  const execution=await Execution.findOneAndUpdate({_id:initial._id,status:'pending_review',createdBy:{$ne:actor.id},...scope(authorization.actor)},{$inc:{revision:1}},{new:true,session}).lean();
  if(!execution)throw fail('Manual movement already reviewed or outside your branch',409);
  const sourceModel=definition(execution.sourceType).model(conn),source=await sourceModel.findById(execution.sourceId).session(session).lean();
  if(!source||hash(sourceSnapshot(execution.sourceType,source))!==execution.sourceFingerprint)throw fail('Original instruction is missing or its economics changed',409);
  if(input.decision==='reject'){
   const rejected=await Execution.findOneAndUpdate({_id:execution._id,status:'pending_review'},{$set:{status:'rejected',reviewedBy:actor.id,reviewedAt:new Date(),reviewNote:note},$unset:{activeKey:''}},{new:true,session}).lean();
   await audit(conn,session,authorization.actor,rejected,'manual.rejected');return {execution:rejected,duplicate:false};
  }
  assertSourceAvailable(source,execution.sourceType,execution.action);
  // This branch write serializes customer balance checks with all existing
  // ledger posting paths before reading the spendable liability balance.
  const branch=await models.branchModel(conn).findOneAndUpdate({_id:execution.branchId,status:'active'},{$inc:{revision:1}},{new:true,session}).lean();
  if(!branch)throw fail('The operating branch is unavailable',409);
  const snapshot=execution.sourceSnapshot;let plan;
  if(execution.action==='transfer_payout'){
   const collection=await Execution.findOne({_id:execution.collectionExecutionId,action:'transfer_collect',status:'posted_manual',sourceId:execution.sourceId}).session(session).lean();
   if(!collection||String(source.manualCollectionExecutionId)!==String(collection._id))throw fail('Collected transfer funds are unavailable or already paid out',409);
   plan={legs:[{accountId:execution.accounts.clearingAccountId,deltaMinor:'-'+snapshot.amountMinor},{accountId:execution.accounts.payoutAccountId,deltaMinor:'-'+snapshot.amountMinor}],ledgerLines:[]};
  }else if(execution.sourceType==='banking'){
   const original=await lockCustomerAccount(conn,session,authorization,snapshot.customerAccountId,execution.branchId,snapshot.currency);
   const destination=snapshot.destinationAccountId?await lockCustomerAccount(conn,session,authorization,snapshot.destinationAccountId,execution.branchId,snapshot.currency):null;
   if(snapshot.kind!=='deposit_request'&&await customerBalance(conn,session,original.ledger._id,execution.branchId,snapshot.currency)<BigInt(snapshot.amountMinor))throw fail('Insufficient posted customer account balance',409);
   plan=economicPlan(snapshot,execution.accounts,{sourceLiabilityId:String(original.ledger._id),destinationLiabilityId:destination?String(destination.ledger._id):null});
  }else plan=economicPlan(snapshot,execution.accounts,{feeIncomeId:await feeAccount(conn,session,authorization,snapshot,execution)});
  const posting=await treasury().applyMovements(conn,session,authorization,{sourceType:execution.sourceType,sourceRef:`FUNDED:${execution._id}`,branchId:String(execution.branchId),operatingActorId:String(execution.createdBy),...plan,evidenceRef:execution.evidenceReference,description:execution.note});
  const changes={status:'posted_manual',reviewedBy:actor.id,reviewedAt:new Date(),reviewNote:note,journalIds:posting.journalIds||[]};
  if(execution.action==='transfer_collect'){
   const generated=pin.generate();changes.pinHash=pin.hash(generated,{tenantId:String(authorization.tenant._id),branchId:String(execution.branchId),phone:snapshot.receiverPhone});
   changes.pinEncrypted=pin.encrypt(generated,`${conn.name}:${execution._id}:${execution.sourceId}`);
  }
  const posted=await Execution.findOneAndUpdate({_id:execution._id,status:'pending_review'},{$set:changes},{new:true,session}).lean();
  const sourceChanges=execution.action==='transfer_collect'?{status:'collected_manual',manualCollectionExecutionId:execution._id,manualPostedAt:new Date()}:
   execution.action==='transfer_payout'?{status:'paid_out_manual',manualPayoutExecutionId:execution._id,manualPostedAt:new Date()}:{status:'posted_manual',manualExecutionId:execution._id,manualPostedAt:new Date()};
  const changed=await sourceModel.findOneAndUpdate({_id:source._id,status:source.status},{$set:sourceChanges,$inc:{revision:1}},{new:true,session,runValidators:true}).lean();
  if(!changed)throw fail('The instruction changed during manual posting',409);
  await audit(conn,session,authorization.actor,posted,'manual.posted',{journalIds:(posting.journalIds||[]).map(String),evidenceMode:'independently_reviewed_manual'});
  return {execution:posted,source:changed,duplicate:false};
 });
}
async function list(conn,tenant,actor,input={}){
 await prepareIndexes(conn);let live=null;const allowed=[];
 for(const type of Object.keys(definitions)){try{const check=await context(conn,tenant,actor,type);live=check;allowed.push(type);}catch(error){if(error.status!==403)throw error;}}
 if(!live||!allowed.length)throw fail('No financial module is assigned to this account',403);
 const filter={sourceType:{$in:allowed},...readScope(live.actor)};
 if(input.status){if(!['pending_review','posted_manual','rejected'].includes(input.status))throw fail('Invalid manual movement status');filter.status=input.status;}
 const rows=await fundedModels(conn).execution.find(filter).sort({createdAt:-1,_id:-1}).limit(100).lean();
 return {items:rows,canReview:allowed.some(type=>hasPermission(live.actor,permission(type,true))),actor:live.actor};
}
async function detail(conn,tenant,actor,executionId){
 if(!tenant?.slug||conn.name!==tenantDbNameFromSlug(tenant.slug))throw fail('Manual financial workspace is invalid',403);
 await prepareIndexes(conn);const execution=await fundedModels(conn).execution.findById(id(executionId)).lean();if(!execution)throw fail('Manual movement not found',404);
 const current=await context(conn,tenant,actor,execution.sourceType),view=scope(current.actor);if(view.branchId&&String(view.branchId)!==String(execution.branchId))throw fail('Manual movement not found in the selected branch',404);
 if(['Banking Operator','Forex Operator','Money Transfer Operator'].includes(current.actor.role)&&String(execution.createdBy)!==current.actor.id)throw fail('Manual movement not found in your scope',404);
 const source=await definition(execution.sourceType).model(conn).findById(execution.sourceId).lean();
 return {execution,source,canReview:execution.status==='pending_review'&&String(execution.createdBy)!==current.actor.id&&hasPermission(current.actor,permission(execution.sourceType,true,execution.action)),canRevealPin:execution.action==='transfer_collect'&&execution.status==='posted_manual'&&!execution.pinShownAt&&(current.actor.role==='Tenant Owner'||String(execution.createdBy)===current.actor.id)};
}
async function revealPin(conn,tenant,actor,executionId){
 await prepareIndexes(conn);const current=await context(conn,tenant,actor,'money_transfer','money_transfer.create');
 return transaction(conn,async session=>{
  const authorization=await auth.fenceAction(conn,session,actor,current.tenant,'money_transfer','money_transfer.create');
  const execution=await fundedModels(conn).execution.findOneAndUpdate({_id:id(executionId),action:'transfer_collect',status:'posted_manual',pinShownAt:null,
   ...(authorization.actor.role==='Tenant Owner'?{}:{createdBy:actor.id}),...scope(authorization.actor)},{$set:{pinShownAt:new Date()},$inc:{revision:1}},{session,new:true}).select('+pinEncrypted').lean();
  if(!execution||!execution.pinEncrypted)throw fail('This PIN has already been displayed or is unavailable',409);
  const value=pin.decrypt(execution.pinEncrypted,`${conn.name}:${execution._id}:${execution.sourceId}`);
  await audit(conn,session,authorization.actor,execution,'transfer.pin_revealed');
  await fundedModels(conn).execution.updateOne({_id:execution._id},{$unset:{pinEncrypted:''}},{session});
  return {pin:value,execution,source:await models.transferOrderModel(conn).findById(execution.sourceId).session(session).lean()};
 });
}
async function reservePinCheck(current,branch,rawPhone){
 const throttle=require('../../platform/services/actionThrottle.service'),now=Date.now(),windowMs=15*60000;
 const phone=typeof rawPhone==='string'?rawPhone.trim().slice(0,24):'invalid';
 const scopes=[['manual-payout-fail-user',`${current.tenant._id}:${current.actor.id}`,30],['manual-payout-fail-phone',`${current.tenant._id}:${branch._id}:${phone}`,10],['manual-payout-fail-branch',`${current.tenant._id}:${branch._id}`,200]];
 const keys=[];
 for(const [category,scope,limit] of scopes){await throttle.consume({category,scope,limit,windowMs,now});keys.push(throttle.throttleKey(category,scope,windowMs,now));}
 return keys;
}
async function refundPinCheck(keys){
 // The budget reserves an attempt before lookup and refunds only a committed
 // successful verification. Wrong guesses remain counted across replicas.
 const Throttle=require('../../platform/models/LoginThrottle');
 await Promise.allSettled(keys.map(_id=>Throttle.updateOne({_id,count:{$gt:0}},{$inc:{count:-1}})));
}
function normalizedName(value){return value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en');}
async function checkPayout(conn,tenant,actor,input={}){
 const current=await context(conn,tenant,actor,'money_transfer','money_transfer.payout');await prepareIndexes(conn);
 const branch=await resolveTransactionBranch(conn,current.actor,input);
 const failureBudget=await reservePinCheck(current,branch,input.receiverPhone);
 const phone=pin.normalPhone(input.receiverPhone),value=text(input.pin,'six-digit payout PIN',6,6),pinHash=pin.hash(value,{tenantId:String(current.tenant._id),branchId:String(branch._id),phone});
 const collection=await fundedModels(conn).execution.findOne({action:'transfer_collect',status:'posted_manual',branchId:branch._id,pinHash}).lean();
 const source=collection?await models.transferOrderModel(conn).findOne({_id:collection.sourceId,status:'collected_manual',manualCollectionExecutionId:collection._id}).lean():null;
 const nameCheck=text(input.receiverNameCheck||'','receiver name check',0,120),identityDocument=text(input.identityDocument||'','ID / Passport presented',0,80);
 if(!collection||!source||(nameCheck&&normalizedName(nameCheck)!==normalizedName(source.beneficiary.name)))throw fail('PIN and receiver details could not be matched',404);
 const token=crypto.randomBytes(32).toString('hex');
 const verification=await transaction(conn,async session=>{
  const authorization=await auth.fenceAction(conn,session,actor,current.tenant,'money_transfer','money_transfer.payout',{branchId:String(branch._id)});
  const fresh=await models.transferOrderModel(conn).findOne({_id:source._id,status:'collected_manual',manualCollectionExecutionId:collection._id}).session(session).lean();if(!fresh)throw fail('PIN and receiver details could not be matched',404);
  const [verified]=await fundedModels(conn).verification.create([{collectionExecutionId:collection._id,branchId:branch._id,createdBy:actor.id,tokenHash:pin.tokenHash(token),expiresAt:new Date(Date.now()+5*60000),receiverName:source.beneficiary.name,receiverPhone:phone,receiverNameCheck:nameCheck,identityDocument}],{session});
  await audit(conn,session,authorization.actor,collection,'transfer.pin_checked');return verified;
 });
 await refundPinCheck(failureBudget);
 return {id:String(verification._id),token};
}
async function payoutContext(conn,tenant,actor,state){
 const current=await context(conn,tenant,actor,'money_transfer','money_transfer.payout');await prepareIndexes(conn);
 if(!state?.token||!state?.id)return {verification:null,idempotencyKey:crypto.randomUUID()};
 const verification=await fundedModels(conn).verification.findOne({_id:id(state.id),tokenHash:pin.tokenHash(state.token),createdBy:actor.id,consumedAt:null,expiresAt:{$gt:new Date()}}).lean();
 if(!verification||String(verification.branchId)!==String((await resolveTransactionBranch(conn,current.actor))._id))return {verification:null,idempotencyKey:crypto.randomUUID()};
 const collection=await fundedModels(conn).execution.findOne({_id:verification.collectionExecutionId,status:'posted_manual'}).lean();
 const source=collection?await models.transferOrderModel(conn).findOne({_id:collection.sourceId,status:'collected_manual'}).lean():null;
 return source?{verification,collection,source,verificationToken:state.token,idempotencyKey:crypto.randomUUID()}:{verification:null,idempotencyKey:crypto.randomUUID()};
}
async function requestPayout(conn,tenant,actor,input={}){
 const v=formInput(input),current=await context(conn,tenant,actor,'money_transfer','money_transfer.payout');await prepareIndexes(conn);
 const Execution=fundedModels(conn).execution,tokenHash=pin.tokenHash(input.verificationToken);
 const prior=await Execution.findOne({idempotencyKey:v.idempotencyKey,createdBy:actor.id,action:'transfer_payout',...scope(current.actor)}).select('+verificationDigest').lean();
 if(prior){if(prior.evidenceReference!==v.evidenceReference||prior.note!==v.note||prior.verificationDigest!==tokenHash||(input.payoutAccountId&&String(prior.accounts.payoutAccountId)!==id(input.payoutAccountId)))throw fail('Payout request reference was reused with changed details',409);return {execution:prior,duplicate:true};}
 try{return await transaction(conn,async session=>{
  const authorization=await auth.fenceAction(conn,session,actor,current.tenant,'money_transfer','money_transfer.payout');
  const verification=await fundedModels(conn).verification.findOneAndUpdate({tokenHash,createdBy:actor.id,consumedAt:null,expiresAt:{$gt:new Date()}},{$set:{consumedAt:new Date()}},{session,new:true}).lean();
  if(!verification)throw fail('Payout verification expired or was already used. Check the PIN again.',409);
  const branch=await resolveTransactionBranch(conn,authorization.actor,input);if(String(branch._id)!==String(verification.branchId))throw fail('Payout belongs to a different operating branch',403);
  const collection=await Execution.findOne({_id:verification.collectionExecutionId,action:'transfer_collect',status:'posted_manual',branchId:branch._id}).session(session).lean();
  const source=collection?await models.transferOrderModel(conn).findOne({_id:collection.sourceId,status:'collected_manual',manualCollectionExecutionId:collection._id}).session(session).lean():null;
  if(!source)throw fail('This transfer was paid, changed or is no longer available',409);
  const snapshot=sourceSnapshot('money_transfer',source),available=await availableAccounts(conn,authorization.tenant,authorization.actor,source.branchId,'money_transfer');
  const accounts={clearingAccountId:String(collection.accounts.clearingAccountId),payoutAccountId:choose(available,input.payoutAccountId,{kind:'cash',currency:snapshot.currency,actorId:actor.id,label:'the verified payout cash drawer'})};
  const canonical={sourceType:'money_transfer',sourceId:String(source._id),sourceReference:source.reference,action:'transfer_payout',branchId:String(branch._id),createdBy:actor.id,accounts,collectionExecutionId:String(collection._id),...v};
  const [execution]=await Execution.create([{...canonical,fingerprint:hash(canonical),sourceFingerprint:hash(snapshot),sourceSnapshot:snapshot,verificationDigest:tokenHash,verificationInfo:{receiverNameCheck:verification.receiverNameCheck,identityDocument:verification.identityDocument},activeKey:`money_transfer:${source._id}:transfer_payout`}],{session});
  await audit(conn,session,authorization.actor,execution,'payout.requested');return {execution,duplicate:false};
 });}catch(error){if(error.code===11000)throw fail('A payout is already pending or posted for this transfer',409);throw error;}
}
module.exports={definitions,definition,sourceSnapshot,economicPlan,context,prepare,request,review,list,detail,revealPin,checkPayout,payoutContext,requestPayout,prepareIndexes,fail,minor,paymentKind,choose};
