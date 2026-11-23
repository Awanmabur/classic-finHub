'use strict';
// Operational funds book. A manual declaration is dated evidence, not a live
// provider balance. Openings need independent review; mismatches never silently
// reset the book. Every posted movement has balanced append-only ledger lines.
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const Tenant=require('../../platform/models/Tenant');
const core=require('../models');
const {models,ensure}=require('./models');
const ledger=require('../services/ledger.service');
const {currencyCodes,currencies}=require('../../config/currencies');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const {permissionsFor,requiresTenantMfa}=require('../../config/roles');
const {hasPermission,hasModuleForUser}=require('../services/moduleAccess.service');
const {effectiveSubscription}=require('../../platform/services/commercial.service');
const {activeGrants}=require('../../platform/services/moduleSubscriptions.service');
const {resolveTransactionBranch}=require('../services/transactionBranch.service');
const OID=/^[a-f0-9]{24}$/i,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SOURCES=['mobile_money','money_transfer','banking','forex','expenses','loans','airtime'];
const KINDS=['wallet','cash','bank','forex_stock','transfer_clearing'];
const {networks:NETWORKS}=require('../../config/mobileNetworks');
const REVIEW_ROLES=['Tenant Owner','Reconciliation Officer','Branch Manager'];
const MAX=999999999999999999n;
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function oid(value,label='record'){if(!OID.test(String(value||'')))throw fail(`Invalid ${label}`);return new mongoose.Types.ObjectId(String(value));}
function text(value,label,min=0,max=120){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||/[<>\u0000-\u001f\u007f]/.test(value))throw fail(`Invalid ${label}`);return value.trim();}
function key(value){if(typeof value!=='string'||!UUID.test(value))throw fail('Reload the form to obtain a valid request reference');return value.toLowerCase();}
function reference(value){const result=text(value,'source reference',6,120);if(!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(result))throw fail('Invalid source reference');return result;}
function signedMinor(value,{zero=true}={}){const s=String(value??'');if(!/^-?(?:0|[1-9]\d{0,17})$/.test(s)||BigInt(s)>MAX||BigInt(s)<-MAX||(!zero&&BigInt(s)===0n))throw fail('Use a bounded exact integer minor-unit amount');return BigInt(s);}
function major(value,currency,{negative=false}={}){if(!currencyCodes.includes(currency)||typeof value!=='string'||!/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/.test(value))throw fail('Enter an exact amount in a supported currency');const sign=value.startsWith('-')?-1n:1n,[whole,fraction='']=value.replace(/^-/,'').split('.'),scale=currencies[currency];if(fraction.length>scale||(!negative&&sign<0n))throw fail('Invalid balance precision or negative balance');return signedMinor(String(sign*(BigInt(whole)*10n**BigInt(scale)+BigInt(fraction.padEnd(scale,'0')||'0'))));}
function decimal(value){return mongoose.Types.Decimal128.fromString(String(value));}
function format(value,currency){return require('../services/mobileMoney.service').formatMoneyMinor(value,currency);}
function context(conn,tenant){if(!tenant?.slug||conn?.name!==tenantDbNameFromSlug(tenant.slug)||tenant.dbName!==conn.name)throw fail('Funds account tenant context does not match this database',403);oid(tenant._id,'tenant');}
function trusted(person){return {id:String(person._id),name:person.name,role:person.role,authVersion:person.authVersion||0,branchId:person.branchId||null,permissions:permissionsFor(person.role),allowedModules:Array.isArray(person.allowedModules)?person.allowedModules:[]};}
function availableModules(tenant,actor){return SOURCES.filter(module=>hasModuleForUser(tenant,actor,module)&&hasPermission(actor,`${module}.view`));}
async function access(conn,tenant,actor,{permission='treasury.view',session=null,fence=false,sourceType=null}={}){
 context(conn,tenant);oid(actor?.id,'staff account');
 const tenantFilter={_id:tenant._id,slug:tenant.slug,dbName:conn.name,status:{$in:['active','trial']}};
 const tq=fence?Tenant.findOneAndUpdate(tenantFilter,{$inc:{__v:1}},{session,new:true}):Tenant.findOne(tenantFilter).session(session);
 const currentTenant=await tq.lean();if(!currentTenant||(!effectiveSubscription(currentTenant)&&!activeGrants(currentTenant).length))throw fail('An active subscribed financial workspace is required',403);
 const filter={_id:actor.id,status:'active'};
 if(fence){filter.role=actor.role;const version=actor.authVersion??0;if(!Number.isSafeInteger(version)||version<0)throw fail('Staff authorization context changed',403);filter.authVersion=version===0?{$in:[0,null]}:version;}
 const uq=fence?core.tenantUserModel(conn).findOneAndUpdate(filter,{$inc:{__v:1}},{session,new:true}):core.tenantUserModel(conn).findOne(filter).session(session);
 const person=await uq.lean();if(!person)throw fail('Funds account staff access was revoked',403);
 const current=fence?trusted(person):require('../services/branchView.service').withReadView(trusted(person),actor);
 if(!hasPermission(current,permission))throw fail('Funds account permission required',403);
 if(require('../../config/mfaPolicy').enabled()&&requiresTenantMfa(current.role)&&!person.mfaEnabledAt)throw fail('Authenticator enrollment is required for privileged funds controls',403);
 if(fence&&current.role!=='Tenant Owner'&&String(current.branchId||'')!==String(actor.branchId||''))throw fail('Your branch assignment changed. Reload before saving.',409);
 const modules=availableModules(currentTenant,current);if(!modules.length||(sourceType&&!modules.includes(sourceType)))throw fail('The relevant financial module is not assigned to this account',403);
 if(!['Tenant Owner','Auditor'].includes(current.role)){
  const branchQuery=core.branchModel(conn).findOne({_id:oid(current.branchId,'assigned branch'),status:'active'});if(session)branchQuery.session(session);
  if(!await branchQuery.lean())throw fail('The assigned branch is unavailable',403);
 }
 return {tenant:currentTenant,actor:current,modules,underlyingModules:SOURCES.filter(module=>hasModuleForUser(currentTenant,current,module))};
}
function scope(actor){return ['Tenant Owner','Auditor'].includes(actor.role)?require('../services/branchView.service').readScope(actor):{branchId:oid(actor.branchId,'assigned branch')};}
function moduleForKind(kind){return ({wallet:'mobile_money',forex_stock:'forex',transfer_clearing:'money_transfer'})[kind]||'shared';}
function normalSide(kind){return kind==='transfer_clearing'?'credit':'debit';}
function canSee(account,authorization){return (account.moduleKey==='shared'||(authorization.underlyingModules||authorization.modules).includes(account.moduleKey))&&
 (REVIEW_ROLES.includes(authorization.actor.role)||authorization.actor.role==='Auditor'||!account.operatorId||String(account.operatorId)===authorization.actor.id);}
async function selectedBranch(conn,authorization,session=null){const Branch={findOne:query=>core.branchModel(conn).findOne(query).session(session),find:query=>core.branchModel(conn).find(query).session(session)};return resolveTransactionBranch(conn,authorization.actor,{}, {Branch});}
async function loadAccount(conn,authorization,accountId,{session=null,fence=false}={}){
 const filter={_id:oid(accountId,'funds account'),tenantId:authorization.tenant._id,...scope(authorization.actor)};
 const q=fence?models(conn).account.findOneAndUpdate(filter,{$inc:{revision:1}},{session,new:true}):models(conn).account.findOne(filter).session(session);
 const account=await q.lean();if(!account||!canSee(account,authorization))throw fail('Funds account not found in your permitted scope',404);return account;
}
async function transaction(conn,handler){const session=await conn.startSession();try{let result;await session.withTransaction(async()=>{result=await handler(session);},{readConcern:{level:'snapshot'}});return result;}finally{await session.endSession();}}
async function audit(conn,session,actor,action,targetId,metadata){await core.auditEventModel(conn).create([{action,actorId:actor.id,targetId,metadata}],{session});}
function validateAccount(input){
 const code=input.code?text(input.code,'account code',3,40).toUpperCase():null;
 if(code&&!/^[A-Z][A-Z0-9_]{2,39}$/.test(code))throw fail('Use a valid account code with letters, numbers and underscores');
 const name=text(input.name,'account name',3,120),kind=input.kind,currency=input.currency,network=input.network||'';
 if(!KINDS.includes(kind)||!currencyCodes.includes(currency)||(kind==='wallet'?!NETWORKS.includes(network):network!==''))throw fail('Choose a valid account kind, currency and wallet network');
 if(kind==='wallet'){
  const fixedCurrency=require('../pricing/networkTariffs').NETWORKS[network]?.currency;
  if(fixedCurrency&&currency!==fixedCurrency)throw fail('This network requires '+fixedCurrency+'. Currency is derived from the provider market.',409);
 }
 const operatorId=input.operatorId?String(oid(input.operatorId,'assigned operator')):null;if(kind==='cash'&&!operatorId)throw fail('A cash drawer must be assigned to its actual operator');
 const accountReference=text(input.accountReference||'','wallet or account identifier',0,80);
 if(input.isDefault!==undefined&&!['true','false','auto',true,false,'on'].includes(input.isDefault))throw fail('Choose a valid default-account option');
 return {code,name,kind,currency,network,operatorId,accountReference,isDefault:input.isDefault==='auto'?'auto':input.isDefault===undefined||['true',true,'on'].includes(input.isDefault)};
}
async function configureAccount(conn,tenant,actor,accountId,input){
 await ensure(conn);
 const name=text(input.name,'account name',3,120),isDefault=['true',true,'on'].includes(input.isDefault);
 if(!['true','false',true,false,'on'].includes(input.isDefault))throw fail('Choose whether this account is the default');
 const feeTreatment=input.feeTreatment||'record_only';if(!['record_only','payment_collected'].includes(feeTreatment))throw fail('Provider commission must be recognized from independently verified payout evidence, not as estimated transaction float. Choose Record only or Verified customer fee collected.');
 return transaction(conn,async session=>{
  const authorization=await access(conn,tenant,actor,{permission:'treasury.manage',session,fence:true});
  if(!['Tenant Owner','Branch Manager'].includes(authorization.actor.role))throw fail('Authorized tenant owner or assigned branch manager required',403);
  const account=await loadAccount(conn,authorization,accountId,{session,fence:true});
  if(account.status==='archived')throw fail('Restore this funds account before changing its settings',409);
  // The owner chooses this once, not the agent on every operation. Restrict
  // mapping to a genuine, approved, same-branch and same-currency cash account.
  // An operator-bound wallet can only map to its own operator's cash drawer.
  let linkedCashId;
  if(account.kind==='wallet'&&input.cashDrawerAccountId!==undefined){
   const requested=String(input.cashDrawerAccountId||'').trim();
   if(requested){
    const drawer=await models(conn).account.findOne({
     _id:oid(requested,'cash drawer'),tenantId:authorization.tenant._id,
     branchId:account.branchId,currency:account.currency,kind:'cash',
     status:'active',reconciliationState:'matched',openingApprovedAt:{$ne:null}
    }).session(session).lean();
    if(!drawer||!drawer.operatorId)throw fail('Choose a verified physical cash drawer in the same branch and currency.',409);
    if(account.operatorId&&String(drawer.operatorId)!==String(account.operatorId))
     throw fail('A wallet assigned to a specific agent must link to that same agent’s cash drawer.',409);
    const conflict=await core.cashSessionModel(conn).exists({
     branchId:account.branchId,operatorId:drawer.operatorId,currency:account.currency,
     status:{$in:['pending_open','open','submitted','disputed']},
     treasuryAccountId:{$ne:drawer._id}
    }).session(session);
    if(conflict)throw fail('This operator already has an unfinished shift for another physical cash drawer in the same currency. Finish the independent cash review before changing wallet-to-drawer custody.',409);
    linkedCashId=drawer._id;
   }else linkedCashId=null;
  }

  const selectionKey=`${account.branchId}:${account.kind}:${account.network}:${account.currency}:${account.operatorId||'shared'}`;
  if(isDefault)await models(conn).account.updateMany({_id:{$ne:account._id},tenantId:authorization.tenant._id,selectionKey},{$unset:{selectionKey:''},$inc:{revision:1}},{session});
  const changes={$set:{name,feeTreatment:account.kind==='wallet'?feeTreatment:'record_only',
   ...(linkedCashId!==undefined?{cashDrawerAccountId:linkedCashId}:{})},$inc:{revision:1},
   ...(isDefault?{}:{$unset:{selectionKey:''}})};
  if(isDefault)changes.$set.selectionKey=selectionKey;
  const configured=await models(conn).account.findOneAndUpdate({_id:account._id,tenantId:authorization.tenant._id},changes,{session,new:true,runValidators:true}).lean();
  await audit(conn,session,authorization.actor,'treasury.account.configured',account._id,{branchId:String(account.branchId),isDefault,feeTreatment:configured.feeTreatment,
   cashDrawerAccountId:String(configured.cashDrawerAccountId||'')});
  return configured;
 });
}
async function createAccount(conn,tenant,actor,input,{configurationBranchId=null}={}){
 const values=validateAccount(input);await Promise.all([ensure(conn),core.ensureTenantIndexes(conn)]);
 try{return await transaction(conn,async session=>{
  const authorization=await access(conn,tenant,actor,{permission:'treasury.manage',session,fence:true});if(!['Tenant Owner','Branch Manager'].includes(authorization.actor.role))throw fail('Authorized tenant owner or assigned branch manager required',403);
  if(configurationBranchId&&authorization.actor.role==='Branch Manager'&&String(configurationBranchId)!==String(authorization.actor.branchId))throw fail('Branch managers can create accounts only in their assigned branch',403);
  const branch=configurationBranchId?await core.branchModel(conn).findOne({_id:oid(configurationBranchId,'configuration branch'),status:'active'}).session(session).lean():await selectedBranch(conn,authorization,session);
  if(!branch)throw fail('Choose an active branch before adding an account',409);
  if(!authorization.modules.includes(moduleForKind(values.kind))&&moduleForKind(values.kind)!=='shared')throw fail('Subscribe and assign the account financial module first',403);
  require('../services/branchCurrency.service').resolve(branch,values.currency);
  if(values.operatorId){const operator=await core.tenantUserModel(conn).findOne({_id:values.operatorId,status:'active'}).session(session).lean();if(!operator||(operator.role!=='Tenant Owner'&&String(operator.branchId)!==String(branch._id))||(authorization.actor.role==='Branch Manager'&&String(operator.branchId)!==String(branch._id)))throw fail('Choose an active staff member from this branch',409);}
  const accountId=new mongoose.Types.ObjectId(),ledgerCode=`TRS_${accountId.toString().toUpperCase()}`;
  // The user never needs to invent a bookkeeping code. Use the immutable
  // ObjectId suffix so concurrently created accounts have distinct codes.
  const autoPrefix=(values.kind==='wallet'?values.network.replace(/[^A-Za-z0-9]+/g,'_'):values.kind).toUpperCase();
  const accountCode=values.code||`${autoPrefix}_${values.currency}_${accountId.toString().slice(-8).toUpperCase()}`;
  // Avoid duplicate setup names in the same real account group; this never
  // alters old ledger identities or joins different currencies.
  const duplicate=await models(conn).account.findOne({
   tenantId:authorization.tenant._id,branchId:branch._id,kind:values.kind,
   currency:values.currency,network:values.network,operatorId:values.operatorId,
   status:{$ne:'archived'},name:values.name
  }).collation({locale:'en',strength:2}).select('_id').session(session).lean();
  if(duplicate)throw fail('An account with this name already exists for the same type, currency and operator. Choose a distinguishing name or edit the existing one.',409);
  const defaultKey=`${branch._id}:${values.kind}:${values.network}:${values.currency}:${values.operatorId||'shared'}`;
  // "auto" is chosen by owner Quick setup and the detailed Treasury form.
  // Only the first account in that group becomes the automatic default.
  const isDefault=values.isDefault==='auto'
   ? !(await models(conn).account.exists({tenantId:authorization.tenant._id,selectionKey:defaultKey}).session(session))
   : values.isDefault;
  const selectionKey=isDefault?defaultKey:undefined;
  const [chart]=await core.ledgerAccountModel(conn).create([{branchId:branch._id,code:ledgerCode,name:values.name,currency:values.currency,category:values.kind==='transfer_clearing'?'liability':'asset',createdBy:authorization.actor.id}],{session});
  const [created]=await models(conn).account.create([{_id:accountId,tenantId:authorization.tenant._id,branchId:branch._id,code:accountCode,name:values.name,kind:values.kind,moduleKey:moduleForKind(values.kind),network:values.network,currency:values.currency,operatorId:values.operatorId,accountReference:values.accountReference,selectionKey,ledgerAccountId:chart._id,ledgerCode,createdBy:authorization.actor.id}],{session});
  await audit(conn,session,authorization.actor,'treasury.account.created',created._id,{branchId:String(branch._id),kind:created.kind,currency:created.currency,code:created.code});return created;
 });}catch(error){if(error.code===11000)throw fail('The default funds account is already assigned or this account already exists. Review existing accounts before trying again.',409);throw error;}
}
// Owner cleanup is a SOFT archive of mistaken, UNUSED setup accounts.
// Real money and operational evidence may never be discarded or hidden.
function assertUnusedAccountArchivable(account,confirmCode){
 if(!['wallet','cash','bank','forex_stock'].includes(account.kind))
  throw fail('This account type cannot be removed from setup',409);
 if(account.code!==confirmCode)
  throw fail('Account confirmation does not match. Reload setup and retry.',400);
 if(account.status!=='uninitialized'||account.openingBalanceMinor!==null||account.openingApprovedAt||
    account.openingObservationId||account.pendingOpeningId||account.lastObservationId||
    account.sequence!==0||BigInt(String(account.bookBalanceMinor))!==0n||
    account.reconciliationState!=='unknown')
  throw fail('This account already has an opening, balance, cash activity or financial evidence. Keep its history and reconcile it instead.',409);
}
async function archiveUnusedAccount(conn,tenant,actor,accountId,input={}){
 const confirmCode=text(input.confirmCode,'account confirmation',3,40).toUpperCase();
 const reason=text(input.reason||'Owner archived an unused setup account.','account archival reason',12,400);
 await Promise.all([ensure(conn),core.ensureTenantIndexes(conn)]);
 return transaction(conn,async session=>{
  const authorization=await access(conn,tenant,actor,{permission:'treasury.manage',session,fence:true});
  if(authorization.actor.role!=='Tenant Owner')throw fail('Only the Tenant Owner may archive setup accounts',403);
  const account=await loadAccount(conn,authorization,accountId,{session,fence:true});
  assertUnusedAccountArchivable(account,confirmCode);
  const treasury=models(conn),funding=require('./funding.models').model(conn);
  const key=account._id,linkedFunds=await treasury.account.exists({
   cashDrawerAccountId:key,status:{$ne:'archived'}
  }).session(session);
  const tasks=[
   treasury.observation.exists({accountId:key,status:{$ne:'rejected'}}).session(session),
   treasury.movement.exists({accountId:key}).session(session),
   treasury.adjustment.exists({accountId:key}).session(session),
   funding.exists({$or:[{sourceAccountId:key},{destinationAccountId:key}]}).session(session),
   core.mobileTransactionModel(conn).exists({$or:[{walletAccountId:key},{paymentAccountId:key}]}).session(session),
   core.ledgerPostingModel(conn).exists({accountId:account.ledgerAccountId}).session(session),
   core.cashSessionModel(conn).exists({treasuryAccountId:key}).session(session),
   require('../models/expenses').expenseModel(conn).exists({
    $or:[{treasuryAccountId:key},{postedTreasuryAccountId:key}]
   }).session(session),
   require('../funded/models').models(conn).execution.exists({
    $or:['cashAccountId','foreignAccountId','settlementAccountId','collectionAccountId',
      'clearingAccountId','payoutAccountId'].map(field=>({['accounts.'+field]:key}))
   }).session(session)
  ];
  // Never execute queries concurrently on one MongoDB transaction session.
  const blockers=[];
  for(const query of tasks)blockers.push(await query);
  if(linkedFunds||blockers.some(Boolean))
   throw fail('This account has linked financial or cash-shift records and cannot be removed. Its history must stay available.',409);
  const updated=await treasury.account.findOneAndUpdate({
   _id:key,tenantId:authorization.tenant._id,status:'uninitialized',revision:account.revision
  },{$set:{status:'archived',holdReason:'Archived unused setup account by Tenant Owner.'},
     $unset:{selectionKey:''},$inc:{revision:1}},{new:true,session}).lean();
  if(!updated)throw fail('Account changed while archiving. Reload the page.',409);
  await audit(conn,session,authorization.actor,'treasury.account.archived',key,{
   branchId:String(account.branchId),code:account.code,kind:account.kind,reason,
   retainedEvidence:'Existing account identity and rejected observations'
  });
  return updated;
 });
}
async function restoreArchivedAccount(conn,tenant,actor,accountId){
 await Promise.all([ensure(conn),core.ensureTenantIndexes(conn)]);
 return transaction(conn,async session=>{
  const authorization=await access(conn,tenant,actor,{permission:'treasury.manage',session,fence:true});
  if(authorization.actor.role!=='Tenant Owner')throw fail('Only the Tenant Owner can restore setup accounts',403);
  const account=await loadAccount(conn,authorization,accountId,{session,fence:true});
  if(account.status!=='archived'||account.openingBalanceMinor!==null||account.sequence!==0||
     BigInt(String(account.bookBalanceMinor))!==0n||account.pendingOpeningId||
     account.openingApprovedAt)
   throw fail('Only a previously archived, unused setup account can be restored',409);
  const branch=await core.branchModel(conn).findOne({_id:account.branchId,status:'active'}).session(session);
  if(!branch)throw fail('Restore the branch first before restoring the account.',409);
  if(!authorization.modules.includes(account.moduleKey)&&account.moduleKey!=='shared')
   throw fail('This financial module is no longer assigned',403);
  require('../services/branchCurrency.service').resolve(branch,account.currency);
  const restored=await models(conn).account.findOneAndUpdate({
   _id:account._id,tenantId:authorization.tenant._id,status:'archived',revision:account.revision
  },{$set:{status:'uninitialized',holdReason:''},$inc:{revision:1}},{session,new:true}).lean();
  if(!restored)throw fail('Account changed while restoring. Reload and inspect it.',409);
  await audit(conn,session,authorization.actor,'treasury.account.restored',account._id,{
   branchId:String(account.branchId),code:account.code,kind:account.kind
  });
  return restored;
 });
}
// Closing an already-used account is NOT deletion. It preserves every
// transaction, account identifier, observation and ledger posting. Require a
// verified, post-activity ZERO balance and no unfinished work before hiding.
function assertSettledAccountClosable(account,confirmCode){
 if(!['wallet','cash','bank','forex_stock'].includes(account.kind))
  throw fail('This account type cannot be closed from the business setup',409);
 if(account.code!==confirmCode)throw fail('Type the exact account code to confirm closure',400);
 if(account.status!=='active'||account.openingBalanceMinor===null||!account.openingApprovedAt||
    account.reconciliationState!=='matched'||account.lastObservationStale||
    !account.lastObservationAt||account.pendingOpeningId||
    BigInt(String(account.bookBalanceMinor))!==0n||
    account.lastObservedMinor===null||BigInt(String(account.lastObservedMinor))!==0n||
    account.lastExpectedAtObservationMinor===null||
    BigInt(String(account.lastExpectedAtObservationMinor))!==0n||
    account.lastVarianceMinor===null||BigInt(String(account.lastVarianceMinor))!==0n)
  throw fail('To close an account, settle it to zero, record a fresh actual zero balance and resolve any Held or pending review status.',409);
 if(account.selectionKey)throw fail('Choose another default account first, then close this one.',409);
}
async function closeSettledAccount(conn,tenant,actor,accountId,input={}){
 const confirmCode=text(input.confirmCode,'account code',3,40).toUpperCase();
 const reason=text(input.reason,'reason for closing this account',12,400);
 await Promise.all([ensure(conn),core.ensureTenantIndexes(conn)]);
 return transaction(conn,async session=>{
  const auth=await access(conn,tenant,actor,{permission:'treasury.manage',session,fence:true});
  if(auth.actor.role!=='Tenant Owner')throw fail('Only the Tenant Owner may close an account',403);
  const account=await loadAccount(conn,auth,accountId,{session,fence:true});
  assertSettledAccountClosable(account,confirmCode);
  await assertBookIntegrity(conn,session,account);
  const t=models(conn),key=account._id;
  // A zero balance shown before a later posting is not a valid closure count.
  const lastMovement=await t.movement.findOne({accountId:key})
    .select('createdAt').sort({sequence:-1}).session(session).lean();
  if(lastMovement&&new Date(account.lastObservationAt)<new Date(lastMovement.createdAt))
   throw fail('Count and record the actual zero balance after the last transaction before closing.',409);
  const orFunds={$or:[{sourceAccountId:key},{destinationAccountId:key}]};
  const orMobile={$or:[{walletAccountId:key},{paymentAccountId:key}]};
  const orExecution={$or:['cashAccountId','foreignAccountId','settlementAccountId',
    'collectionAccountId','clearingAccountId','payoutAccountId'].map(field=>({['accounts.'+field]:key}))};
  // Historical records do not block closure. Only active dependencies and
  // pending decisions do; all settled evidence remains stored immutably.
  const checks=[
   t.account.exists({cashDrawerAccountId:key,status:{$ne:'archived'}}).session(session),
   t.observation.exists({accountId:key,status:'pending_review'}).session(session),
   t.adjustment.exists({accountId:key,status:'pending_review'}).session(session),
   require('./funding.models').model(conn).exists({...orFunds,status:'pending_review'}).session(session),
   core.mobileTransactionModel(conn).exists({$and:[orMobile,{$or:[
    {status:'pending_verification'},{reviewState:'awaiting_review'},{correctionState:'requested'}
   ]}]}).session(session),
   core.cashSessionModel(conn).exists({treasuryAccountId:key,status:{
    $in:['pending_open','open','submitted','disputed']
   }}).session(session),
   require('../models/expenses').expenseModel(conn).exists({
    status:'pending_review',$or:[{treasuryAccountId:key},{postedTreasuryAccountId:key}]
   }).session(session),
   require('../funded/models').models(conn).execution.exists({...orExecution,status:'pending_review'}).session(session)
  ];
  for(const q of checks)if(await q)
   throw fail('This account still has a linked active account, open shift or pending financial review. Finish it before closing.',409);
  const closed=await t.account.findOneAndUpdate({
   _id:key,tenantId:auth.tenant._id,status:'active',revision:account.revision,
   reconciliationState:'matched',bookBalanceMinor:account.bookBalanceMinor
  },{$set:{status:'archived',holdReason:'Closed at verified zero balance by Tenant Owner.'},
     $unset:{selectionKey:''},$inc:{revision:1}},{session,new:true}).lean();
  if(!closed)throw fail('Account changed while closing. Reload to review its latest balance.',409);
  await audit(conn,session,auth.actor,'treasury.account.closed',key,{
   branchId:String(account.branchId),code:account.code,kind:account.kind,
   currency:account.currency,reason,finalBookMinor:'0',
   historyRetained:true,latestCountAt:account.lastObservationAt
  });
  return closed;
 });
}
// Retained for existing integrations that invoke the old wallet-specific API.
const archiveUnusedWallet=archiveUnusedAccount,assertUnusedWalletArchivable=assertUnusedAccountArchivable;
async function ensureCounterAccount(conn,session,{tenantId,branchId,currency,purpose,actorId}){
 if(!session?.inTransaction()||!currencyCodes.includes(currency)||!['opening_equity','capital_contribution','settlement_clearing','reconciliation_suspense','fee_income','agent_commission_income','expense','interbranch_payable','interbranch_receivable','loan_receivable','loan_interest_income','airtime_inventory','airtime_profit_income'].includes(purpose))throw fail('Invalid internal treasury counter account');
 const Counter=models(conn).counter,lookup={branchId:oid(branchId),currency,purpose};let counter=await Counter.findOne(lookup).session(session).lean();if(counter){if(String(counter.tenantId)!==String(tenantId))throw fail('Counter account belongs to a different tenant',403);return counter;}
 const code=`TRS_${purpose.toUpperCase()}_${currency}`;
 const [chart]=await core.ledgerAccountModel(conn).create([{branchId,code,name:`Treasury ${purpose.replaceAll('_',' ')} (${currency})`,currency,category:['opening_equity','capital_contribution'].includes(purpose)?'equity':['fee_income','agent_commission_income','loan_interest_income','airtime_profit_income'].includes(purpose)?'income':purpose==='expense'?'expense':['interbranch_receivable','loan_receivable','airtime_inventory'].includes(purpose)?'asset':'liability',createdBy:oid(actorId)}],{session});
 [counter]=await Counter.create([{tenantId:oid(tenantId),...lookup,ledgerAccountId:chart._id,ledgerCode:code}],{session});return counter;
}
async function expectedAt(conn,account,at,session=null){
 if(account.openingBalanceMinor===null||!account.openingObservedAt)return null;
 if(at<new Date(account.openingObservedAt))throw fail('This observation predates the independently reviewed opening balance',409);
 const rows=await models(conn).movement.aggregate([{$match:{accountId:account._id,occurredAt:{$lte:at}}},{$group:{_id:null,amount:{$sum:'$deltaMinor'}}}]).session(session);
 return BigInt(String(account.openingBalanceMinor))+BigInt(String(rows[0]?.amount||'0'));
}
function parseObservation(input,account){
 const kind=input.kind;if(!['opening','checkpoint'].includes(kind))throw fail('Choose opening balance or balance check');
 const actualMinor=major(input.actualBalance,account.currency,{negative:account.kind==='bank'}),observedAt=new Date(input.observedAt);
 if(typeof input.observedAt!=='string'||!Number.isFinite(observedAt.getTime())||Math.abs(Date.now()-observedAt.getTime())>7*86400000||observedAt.getTime()>Date.now()+60000)throw fail('Use an actual observation time within the last seven days');
 const evidenceType=input.evidenceType,allowed={wallet:['provider_statement','provider_app','provider_sms'],cash:['cash_count'],bank:['bank_statement','provider_app'],forex_stock:['stock_count'],transfer_clearing:['transfer_register','provider_statement']}[account.kind];
 if(!allowed.includes(evidenceType))throw fail('Choose evidence appropriate for this account');
 const evidenceReference=text(input.evidenceReference,'statement, count or provider evidence reference',6,120),note=text(input.note,'evidence explanation',12,400),idempotencyKey=key(input.idempotencyKey);
 let evidenceDigest;if(input.evidenceDigest){if(typeof input.evidenceDigest!=='string'||!/^[a-f0-9]{64}$/i.test(input.evidenceDigest))throw fail('Evidence document checksum must be SHA-256 hexadecimal');evidenceDigest=input.evidenceDigest.toLowerCase();}
 return {kind,actualMinor,observedAt,evidenceType,evidenceReference,evidenceDigest,note,idempotencyKey};
}
function sameObservation(existing,actor,account,value){return String(existing.requestedBy)===actor.id&&String(existing.accountId)===String(account._id)&&existing.kind===value.kind&&String(existing.actualMinor)===String(value.actualMinor)&&new Date(existing.observedAt).getTime()===value.observedAt.getTime()&&existing.evidenceType===value.evidenceType&&existing.evidenceReference===value.evidenceReference&&(existing.evidenceDigest||'')===(value.evidenceDigest||'')&&existing.note===value.note;}
async function requestObservationInSession(conn,session,authorization,accountId,input){
 if(!session?.inTransaction())throw fail('Observation requires an active business transaction',409);
 authorization=await access(conn,authorization.tenant,authorization.actor,{permission:'treasury.observe',session,fence:true});
 const account=await loadAccount(conn,authorization,accountId,{session,fence:true}),value=parseObservation(input,account);
  if(account.status==='archived')throw fail('Restore this funds account before recording evidence',409);
  const prior=await models(conn).observation.findOne({idempotencyKey:value.idempotencyKey}).session(session).lean();if(prior){if(!sameObservation(prior,authorization.actor,account,value))throw fail('Evidence reference reused with different observation details',409);return {observation:prior,duplicate:true};}
  if(value.kind==='opening'&&(account.openingBalanceMinor!==null||account.pendingOpeningId))throw fail('An opening balance already exists or awaits review. Use a balance check after opening.',409);
  if(value.kind==='checkpoint'&&account.openingBalanceMinor===null)throw fail('Obtain independent opening approval first',409);
  const expected=value.kind==='opening'?null:await expectedAt(conn,account,value.observedAt,session),observationId=new mongoose.Types.ObjectId();
  const [observation]=await models(conn).observation.create([{_id:observationId,tenantId:authorization.tenant._id,branchId:account.branchId,accountId:account._id,...value,actualMinor:decimal(value.actualMinor),expectedMinorAtRequest:expected===null?null:decimal(expected),varianceMinorAtRequest:expected===null?null:decimal(value.actualMinor-expected),requestedBy:authorization.actor.id}],{session});
  if(value.kind==='opening')await models(conn).account.updateOne({_id:account._id,pendingOpeningId:null},{$set:{pendingOpeningId:observation._id}},{session});
  if(value.kind==='checkpoint'&&value.actualMinor!==expected&&(!account.lastObservationAt||value.observedAt>=new Date(account.lastObservationAt)))await models(conn).account.updateOne({_id:account._id},{$set:{status:'held',reconciliationState:'mismatch',holdReason:'Reported actual balance differs from the book; independent review required.'}},{session});
  await audit(conn,session,authorization.actor,'treasury.observation.requested',observation._id,{branchId:String(account.branchId),accountId:String(account._id),kind:value.kind,currency:account.currency,evidenceType:value.evidenceType});return {observation,duplicate:false};
}
async function requestObservation(conn,tenant,actor,accountId,input){
 await ensure(conn);return transaction(conn,async session=>{const authorization=await access(conn,tenant,actor,{permission:'treasury.observe',session,fence:true});return requestObservationInSession(conn,session,authorization,accountId,input);});
}
async function confirmOwnerOpening(conn,tenant,actor,accountId,input={}){
 // The established reviewer policy already allows a persisted Tenant Owner to
 // self-review a routine first opening. Combine both steps atomically so a
 // sole proprietor does not have to navigate a separate approval queue.
 if(actor?.role!=='Tenant Owner')throw fail('Only the business owner can confirm an opening balance',403);
 if(!input||typeof input!=='object'||Array.isArray(input)||
    Object.keys(input).some(k=>!['actualBalance','idempotencyKey'].includes(k)))
  throw fail('Unexpected opening balance field');
 const keyValue=key(input.idempotencyKey);
 await ensure(conn);
 return transaction(conn,async session=>{
  const auth=await access(conn,tenant,actor,{permission:'treasury.observe',session,fence:true});
  if(auth.actor.role!=='Tenant Owner')throw fail('Only the business owner can confirm the opening',403);
  const account=await loadAccount(conn,auth,accountId,{session,fence:true});
  const evidenceType={cash:'cash_count',wallet:'provider_app',bank:'bank_statement',
    forex_stock:'stock_count',transfer_clearing:'transfer_register'}[account.kind];
  if(!evidenceType)throw fail('This type of account needs its own opening workflow');
  // This is the owner's manually entered opening amount, not a provider API
  // confirmation. Keep the internal reference in the immutable audit trail.
  const evidenceReference='OWNER-OPEN-'+keyValue;
  // A retry must not depend on a newly sampled server timestamp.
  const prior=await models(conn).observation.findOne({idempotencyKey:keyValue}).session(session).lean();
  if(prior){
   const actual=major(input.actualBalance,account.currency,{negative:account.kind==='bank'});
   if(String(prior.requestedBy)!==auth.actor.id||String(prior.accountId)!==String(account._id)||
      prior.kind!=='opening'||String(prior.actualMinor)!==String(actual)||
      prior.evidenceReference!==evidenceReference)
    throw fail('Opening reference reused for different details',409);
   if(prior.status==='approved')return {observation:prior,duplicate:true};
   throw fail('The same opening is awaiting resolution; open the account details to review.',409);
  }
  const event=await requestObservationInSession(conn,session,auth,accountId,{
    kind:'opening',actualBalance:input.actualBalance,
    observedAt:new Date().toISOString(),
    evidenceType,evidenceReference,
    note:'Tenant owner confirmed physical count or inspected actual provider statement at opening.',
    idempotencyKey:keyValue
  });
  if(event.duplicate){
   if(event.observation.status==='approved')return {observation:event.observation,duplicate:true};
   throw fail('The same opening is awaiting resolution; open the account details to review.',409);
  }
  const confirmed=await reviewObservationInSession(conn,session,auth,event.observation._id,{
    decision:'approve',note:'Tenant Owner directly confirmed opening after checking real evidence.'
  });
  return {observation:confirmed,duplicate:false};
 });
}
// The owner records a dated real-world balance check in one operation. Matching
// checks finish immediately. A difference is recorded and HELD, not booked as
// newly received capital or waved through an independent adjustment.
async function recordOwnerBalanceCheck(conn,tenant,actor,accountId,input={}){
 if(actor?.role!=='Tenant Owner')throw fail('Only the business owner can directly record the balance check',403);
 if(!input||typeof input!=='object'||Array.isArray(input)||
    Object.keys(input).some(k=>!['actualBalance','idempotencyKey'].includes(k)))
  throw fail('Unexpected balance-check field');
 const requestKey=key(input.idempotencyKey);
 await ensure(conn);
 return transaction(conn,async session=>{
  const auth=await access(conn,tenant,actor,{permission:'treasury.observe',session,fence:true});
  if(auth.actor.role!=='Tenant Owner')throw fail('Only the business owner can record direct balance checks',403);
  const account=await loadAccount(conn,auth,accountId,{session,fence:true});
  if(account.status==='archived'||account.openingBalanceMinor===null||!account.openingApprovedAt)
   throw fail('Confirm the account starting balance first',409);
  const actual=major(input.actualBalance,account.currency,{negative:account.kind==='bank'});
  const prior=await models(conn).observation.findOne({idempotencyKey:requestKey}).session(session).lean();
  if(prior){
   if(String(prior.requestedBy)!==auth.actor.id||String(prior.accountId)!==String(account._id)||
      prior.kind!=='checkpoint'||String(prior.actualMinor)!==String(actual))
    throw fail('This balance-check request was reused for different details',409);
   if(prior.status!=='approved')throw fail('This balance check is not finalized; open its account history',409);
   return {observation:prior,duplicate:true,matched:String(prior.varianceMinorAtReview||'0')==='0'};
  }
  const kind={cash:'cash_count',wallet:'provider_app',bank:'bank_statement',
   forex_stock:'stock_count',transfer_clearing:'transfer_register'}[account.kind];
  const requested=await requestObservationInSession(conn,session,auth,accountId,{
    kind:'checkpoint',actualBalance:input.actualBalance,observedAt:new Date().toISOString(),
    evidenceType:kind,evidenceReference:'OWNER-CHECK-'+requestKey,
    note:'Owner entered the actual counted balance. Any difference is kept visible; no funds were invented or erased.',
    idempotencyKey:requestKey
  });
  const approved=await reviewObservationInSession(conn,session,auth,requested.observation._id,{
    decision:'approve',note:'Owner direct balance check. Difference, if present, stays held for investigation.'
  },{ownerDirectCheck:true});
  return {observation:approved,duplicate:false,matched:BigInt(String(approved.varianceMinorAtReview||0))===0n};
 });
}
// A capital contribution is NEW, owner-attested business money, unlike an
// internal funding transfer. It is posted only after real receipt, once per UUID.
// The matching owner-equity credit avoids creating an unbalanced asset journal.
async function addCapital(conn,tenant,actor,accountId,input={}){
 // Only the account, amount, and retry key are entered by the owner.
 // Record an internal traceable reference; never require or fabricate an
 // external provider/bank receipt identifier for manually received funds.
 const requestKey=key(input.idempotencyKey);
 const evidenceReference='CAPITAL-'+requestKey;
 await ensure(conn);
 try{return await transaction(conn,async session=>{
  const authorization=await access(conn,tenant,actor,{permission:'treasury.manage',session,fence:true});
  if(authorization.actor.role!=='Tenant Owner')throw fail('Only the tenant owner can add business capital',403);
  const account=await loadAccount(conn,authorization,accountId,{session,fence:true});
  if(!['cash','wallet','bank','forex_stock'].includes(account.kind))throw fail('Capital can only be received into a real cash, wallet, bank or stock account',409);
  // New capital is a real receipt; it is not a reconciliation or write-off.
  // Record it for a reviewed mismatch, but preserve the hold until resolved.
  const heldMismatch=account.status==='held'&&account.reconciliationState==='mismatch';
  const ready=account.status==='active'&&account.reconciliationState==='matched';
  if((!ready&&!heldMismatch)||account.openingBalanceMinor===null||!account.openingApprovedAt)
   throw fail('Confirm the account opening first. Stale or unavailable accounts need reconciliation before recording new money.',409);
  const amount=major(input.amount,account.currency);
  if(amount<=0n)throw fail('New capital must be greater than zero');
  // The same submission key is safe to retry; this is not external
  // settlement verification and a different submission is a new declaration.
  const counter=await ensureCounterAccount(conn,session,{tenantId:authorization.tenant._id,
    branchId:account.branchId,currency:account.currency,purpose:'capital_contribution',actorId:authorization.actor.id});
  const posted=await applyMovements(conn,session,authorization,{
    sourceType:'treasury_capital',sourceRef:'CAP:'+requestKey,branchId:String(account.branchId),
    operatingActorId:authorization.actor.id,
    legs:[{accountId:String(account._id),deltaMinor:String(amount)}],
    ledgerLines:[{currency:account.currency,accountId:String(counter.ledgerAccountId),
      side:'credit',amountMinor:String(amount)}],
    description:'Owner capital received into business funds',
    evidenceReference
  },{ownerCapital:true,allowHeld:heldMismatch});
  if(!posted.duplicate)await audit(conn,session,authorization.actor,'treasury.capital.posted',posted.batch._id,{
    branchId:String(account.branchId),accountId:String(account._id),currency:account.currency,
    amountMinor:String(amount),evidenceReference,sourceRef:'CAP:'+requestKey,holdPreserved:heldMismatch});
  return {batch:posted.batch,duplicate:posted.duplicate,accountId:String(account._id),currency:account.currency,amountMinor:String(amount),holdPreserved:heldMismatch};
 });}catch(error){
  if(error.code===11000)throw fail('This top-up has already been recorded. Check the account balance before adding more money.',409);
  throw error;
 }
}
function opposite(side){return side==='debit'?'credit':'debit';}
async function writeTreasuryJournal(conn,session,authorization,{branchId,currency,sourceRef,lines}){
 const validated=ledger.validateJournal({branchId:String(branchId),actorId:authorization.actor.id,sourceType:'treasury',sourceRef,currency,lines});
 return ledger.writeOperationalJournalInSession(conn,validated,session);
}
async function reviewObservationInSession(conn,session,authorization,observationId,input,internal={}){
 if(!session?.inTransaction())throw fail('Observation review requires an active transaction',409);
 authorization=await access(conn,authorization.tenant,authorization.actor,{permission:'treasury.review',session,fence:true});
 if(!REVIEW_ROLES.includes(authorization.actor.role))throw fail('Independent funds reviewer required',403);
 const decision=input?.decision,note=text(input?.note,'review explanation',12,400);if(!['approve','reject'].includes(decision))throw fail('Choose approve or reject');
 const {observation:Observation,account:Account}=models(conn);
 const observation=await Observation.findOne({_id:oid(observationId,'observation'),tenantId:authorization.tenant._id,status:'pending_review',...scope(authorization.actor)}).session(session).lean();
 if(!observation)throw fail('Observation is unavailable, already reviewed or outside your branch',409);
 const account=await loadAccount(conn,authorization,observation.accountId,{session,fence:true});
 const selfReviewed=String(observation.requestedBy)===authorization.actor.id||
  String(account.operatorId||'')===authorization.actor.id;
 if(selfReviewed){
  // A directly recorded owner check is evidence only. A discrepancy still
  // HOLDS the account and never posts a cash/equity adjustment by itself.
  const ownerDirect=internal.ownerDirectCheck===true&&
    authorization.actor.role==='Tenant Owner'&&
    observation.kind==='checkpoint'&&
    String(observation.requestedBy)===authorization.actor.id&&decision==='approve';
  const privileged=ownerDirect||require('../services/reviewPolicy').canSelfReviewRoutine(authorization.actor,account.branchId);
  if(!privileged)throw fail('A different authorized person must review the evidence and operator drawer',403);
  // Routine opening or a verified zero-variance cash/float checkpoint can be
  // signed by a branch manager/owner. Discrepancies and adjustments never can.
  if(observation.kind!=='opening'&&!ownerDirect){
   const atObservation=await expectedAt(conn,account,new Date(observation.observedAt),session);
   if(observation.kind!=='checkpoint'||atObservation===null||
      BigInt(String(observation.actualMinor))!==atObservation)
    throw fail('A different authorized person must review a disputed balance',403);
  }
 }
 if(account.status==='archived')throw fail('Archived funds accounts cannot receive balance approval',409);
 let expected=null,variance=null,journalId=null;
 if(decision==='approve'&&observation.kind==='opening'){
  if(account.openingBalanceMinor!==null||String(account.pendingOpeningId)!==String(observation._id))throw fail('This account already has an opening balance or a different pending request',409);
  const actual=BigInt(String(observation.actualMinor));
  if(actual!==0n){const counter=await ensureCounterAccount(conn,session,{tenantId:authorization.tenant._id,branchId:account.branchId,currency:account.currency,purpose:'opening_equity',actorId:authorization.actor.id}),side=actual>0n?normalSide(account.kind):opposite(normalSide(account.kind));
   const journal=await writeTreasuryJournal(conn,session,authorization,{branchId:account.branchId,currency:account.currency,sourceRef:`TRS:OPEN:${observation._id}`,lines:[{accountCode:account.ledgerCode,side,amountMinor:String(actual<0n?-actual:actual)},{accountCode:counter.ledgerCode,side:opposite(side),amountMinor:String(actual<0n?-actual:actual)}]});journalId=journal._id;}
  const changed=await Account.updateOne({_id:account._id,openingBalanceMinor:null,pendingOpeningId:observation._id},{$set:{openingBalanceMinor:observation.actualMinor,bookBalanceMinor:observation.actualMinor,openingObservedAt:observation.observedAt,openingObservationId:observation._id,openingApprovedAt:new Date(),status:actual<0n?'held':'active',reconciliationState:'matched',lastObservationId:observation._id,lastObservationAt:observation.observedAt,lastObservedMinor:observation.actualMinor,lastExpectedAtObservationMinor:observation.actualMinor,lastVarianceMinor:decimal(0),lastObservationStale:false,holdReason:actual<0n?'Observed bank overdraft: no spendable funds.':'',pendingOpeningId:null},$inc:{revision:1}},{session});
  if(changed.modifiedCount!==1)throw fail('Opening account state changed concurrently',409);expected=actual;variance=0n;
 }else if(decision==='approve'){
  expected=await expectedAt(conn,account,new Date(observation.observedAt),session);if(expected===null)throw fail('Opening approval is required',409);variance=BigInt(String(observation.actualMinor))-expected;
  // Historical observations stay auditable but cannot replace a later verified
  // checkpoint or release a hold based on older information.
  if(!account.lastObservationAt||new Date(observation.observedAt)>=new Date(account.lastObservationAt)){
   const matched=variance===0n,nonnegative=BigInt(String(account.bookBalanceMinor))>=0n;
   const holdReason=!matched?'Independently reviewed actual balance differs from the book.':
    !nonnegative?'Negative bank/account balance: spending requires settlement and a fresh balance check.':'';
   await Account.updateOne({_id:account._id},{$set:{lastObservationId:observation._id,lastObservationAt:observation.observedAt,lastObservedMinor:observation.actualMinor,lastExpectedAtObservationMinor:decimal(expected),lastVarianceMinor:decimal(variance),lastObservationStale:false,reconciliationState:matched?'matched':'mismatch',status:matched&&nonnegative?'active':'held',holdReason},$inc:{revision:1}},{session});
  }
 }else if(observation.kind==='opening')await Account.updateOne({_id:account._id,pendingOpeningId:observation._id},{$set:{pendingOpeningId:null},$inc:{revision:1}},{session});
 const updated=await Observation.findOneAndUpdate({_id:observation._id,status:'pending_review'},{$set:{status:decision==='approve'?'approved':'rejected',reviewedBy:authorization.actor.id,reviewedAt:new Date(),reviewNote:note,expectedMinorAtReview:expected===null?null:decimal(expected),varianceMinorAtReview:variance===null?null:decimal(variance),openingJournalId:journalId}},{session,new:true});
 if(!updated)throw fail('Observation was reviewed concurrently',409);
 await audit(conn,session,authorization.actor,`treasury.observation.${decision==='approve'?'approved':'rejected'}`,observation._id,{branchId:String(account.branchId),accountId:String(account._id),kind:observation.kind,currency:account.currency,varianceMinor:variance===null?null:String(variance),selfReviewed});return updated;
}
async function reviewObservation(conn,tenant,actor,observationId,input){await ensure(conn);return transaction(conn,async session=>{const authorization=await access(conn,tenant,actor,{permission:'treasury.review',session,fence:true});return reviewObservationInSession(conn,session,authorization,observationId,input);});}
function stableHash(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function normalizeMovement(input){
 const sourceType=input?.sourceType;if(!SOURCES.includes(sourceType)&&!['treasury_adjustment','treasury_funding','treasury_capital'].includes(sourceType))throw fail('Unsupported funds movement source');
 const sourceRef=reference(input.sourceRef),branchId=String(oid(input.branchId,'operating branch'));
 if(!Array.isArray(input.legs)||input.legs.length>20||(!input.legs.length&&!(Array.isArray(input.ledgerLines)&&input.ledgerLines.length>=2)))throw fail('Choose the actual funds account movements');
 const seen=new Set(),legs=input.legs.map(leg=>{const accountId=String(oid(leg.accountId,'funds account'));if(seen.has(accountId))throw fail('Combine each funds account into one movement');seen.add(accountId);return {accountId,deltaMinor:String(signedMinor(leg.deltaMinor,{zero:false}))};}).sort((a,b)=>a.accountId.localeCompare(b.accountId));
 const ledgerLines=(input.ledgerLines||[]).map(line=>{if(!currencyCodes.includes(line.currency)||!['debit','credit'].includes(line.side))throw fail('Invalid internal counterparty ledger line');const amount=signedMinor(line.amountMinor,{zero:false});if(amount<0n)throw fail('Ledger counterparty amounts must be positive');return {currency:line.currency,accountId:String(oid(line.accountId,'ledger account')),side:line.side,amountMinor:String(amount)};}).sort((a,b)=>(a.currency+a.accountId+a.side).localeCompare(b.currency+b.accountId+b.side));
 if(ledgerLines.length>30)throw fail('Too many counterparty lines');
 let occurredAt=null;if(input.occurredAt!==undefined){const date=new Date(input.occurredAt);if(!Number.isFinite(date.getTime())||date.getTime()>Date.now()+60000||Date.now()-date.getTime()>30*86400000)throw fail('Funds movement time is invalid or outside the 30-day capture window');occurredAt=date.toISOString();}
 return {sourceType,sourceRef,branchId,operatingActorId:input.operatingActorId?String(oid(input.operatingActorId,'operating staff account')):null,legs,ledgerLines,description:text(input.description,'movement explanation',6,400),evidenceReference:text(input.evidenceRef||input.evidenceReference||'','source evidence reference',0,120),occurredAt};
}
async function postingAuthorization(conn,session,authorization,value,internal={}){
 if(internal.branchTransferExecutionId){
  const cashierFinal=internal.cashierFinal===true;
  const {execution,source,collection}=await require('../funded/branchTransfer').validate(conn,session,authorization.tenant,authorization.actor,internal.branchTransferExecutionId,{cashierFinal});
  const counter=await models(conn).counter.findOne({branchId:source.branchId,currency:source.currency,purpose:'interbranch_payable'}).session(session).lean();
  if(value.sourceType!=='money_transfer'||value.sourceRef!==`BRANCH_PAYOUT:${execution._id}:ORIGIN`||value.branchId!==String(source.branchId)||value.operatingActorId!==String(collection.createdBy)||value.legs.length!==1||value.legs[0].accountId!==String(collection.accounts.clearingAccountId)||value.legs[0].deltaMinor!==`-${source.amountMinor}`||value.ledgerLines.length!==1||!counter||value.ledgerLines[0].accountId!==String(counter.ledgerAccountId)||value.ledgerLines[0].currency!==source.currency||value.ledgerLines[0].side!=='credit'||value.ledgerLines[0].amountMinor!==String(source.amountMinor))throw fail('Only the exact originating transfer payable may be reclassified',403);
  const current=await access(conn,authorization.tenant,authorization.actor,{permission:cashierFinal?'money_transfer.payout':'money_transfer.review',session,fence:true,sourceType:'money_transfer'});
  const branch=await core.branchModel(conn).findOneAndUpdate({_id:source.branchId,status:'active'},{$inc:{revision:1}},{session,new:true}).lean();
  if(!branch)throw fail('The sending branch is unavailable',409);
  return {...current,operatingActor:{id:String(collection.createdBy)},operatingBranch:branch,historicalCorrection:false,branchTransfer:true};
 }

 // MoMo FX uses the Forex clearing ledger but belongs to the Mobile Money
 // subscription. Only the dedicated internal settlement service may opt in.
 // Untrusted HTTP fields cannot set the internal argument.
 if(internal.momoFx&&(value.sourceType!=='forex'||
   !(internal.reversesBatchId?
     /^MM-VOID:[0-9a-f]{24}$/i.test(value.sourceRef):
     /^MFX:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.sourceRef))||
   value.legs.length!==2||(!internal.reversesBatchId&&value.ledgerLines.length!==0)))
  throw fail('Invalid Mobile Money cross-currency ledger source',403);
 // Only the dedicated internal-transfer service may request direct posting.
 // It must be an exact balanced pair moving EXISTING funds, never a single
 // credit leg, adjustment or provider money creation.
 const directFunding=internal.directFunding===true;
  const ownerCapital=internal.ownerCapital===true;
  if(value.sourceType==='treasury_capital'&&!ownerCapital)
    throw fail('Owner capital may only be posted through the verified owner funding workflow',403);
  if(ownerCapital){
    const leg=value.legs[0],line=value.ledgerLines[0];
    if(value.sourceType!=='treasury_capital'||!/^CAP:[0-9a-f-]{36}$/.test(value.sourceRef)||
      value.legs.length!==1||value.ledgerLines.length!==1||
      !leg||BigInt(leg.deltaMinor)<=0n||!line||line.side!=='credit'||
      line.amountMinor!==leg.deltaMinor)
      throw fail('Owner capital must credit one genuine funds account and matching equity',403);
  }
 if(directFunding){
  const legs=value.legs;
  if(value.sourceType!=='treasury_funding'||!/^FUND:[0-9a-f]{24}$/i.test(value.sourceRef)||
     legs.length!==2||value.ledgerLines.length!==0||
     BigInt(legs[0].deltaMinor)>=0n||BigInt(legs[1].deltaMinor)<=0n||
     BigInt(legs[0].deltaMinor)+BigInt(legs[1].deltaMinor)!==0n||
     legs[0].accountId===legs[1].accountId)
   throw fail('Direct funding must be an exactly balanced internal transfer',403);
 }
 const internalSource=['treasury_adjustment','treasury_funding','treasury_capital'].includes(value.sourceType),
  source=internal.momoFx?'mobile_money':internalSource?null:value.sourceType;
 const current=await access(conn,authorization.tenant,authorization.actor,{
  permission:ownerCapital?'treasury.manage':directFunding?'treasury.observe':internalSource?'treasury.review':'treasury.observe',
  session,fence:true,sourceType:source});
 if(ownerCapital&&current.actor.role!=='Tenant Owner')throw fail('Only the tenant owner may record new capital',403);
  const branch=await core.branchModel(conn).findOneAndUpdate({_id:value.branchId,status:'active'},{$inc:{revision:1}},{session,new:true}).lean();if(!branch)throw fail('The operating branch is unavailable',409);
 if(current.actor.role!=='Tenant Owner'&&String(current.actor.branchId)!==value.branchId)throw fail('Funds movements cannot cross the assigned branch',403);
 const operatorId=value.operatingActorId||current.actor.id;if(operatorId!==current.actor.id&&!REVIEW_ROLES.includes(current.actor.role))throw fail('Only an authorized reviewer can post a different operator’s execution',403);
 const historicalCorrection=Boolean(internal.reversesBatchId)||value.sourceType==='treasury_adjustment';
 const person=await core.tenantUserModel(conn).findOneAndUpdate({_id:operatorId,...(historicalCorrection?{}:{status:'active'})},{$inc:{__v:1}},{session,new:true}).lean();if(!person||(!historicalCorrection&&person.role!=='Tenant Owner'&&String(person.branchId)!==value.branchId))throw fail('The originating operator is no longer active in this branch',403);
 const operating=trusted(person);if(!historicalCorrection&&source&&(!hasModuleForUser(current.tenant,operating,source)||!hasPermission(operating,`${source}.view`)))throw fail('Originating staff module access changed',403);
 return {...current,operatingActor:operating,operatingBranch:branch,historicalCorrection};
}
async function applyMovements(conn,session,authorization,input,internal={}){
 if(!session?.inTransaction())throw fail('Funds movements must share the business transaction',409);
 const value=normalizeMovement(input),current=await postingAuthorization(conn,session,authorization,value,internal),fingerprint=stableHash({...value,actorId:current.actor.id,reversesBatchId:internal.reversesBatchId?String(internal.reversesBatchId):null});
 const {batch:Batch,movement:Movement,account:Account}=models(conn),prior=await Batch.findOne({sourceType:value.sourceType,sourceRef:value.sourceRef}).session(session).lean();
 if(prior){if(prior.fingerprint!==fingerprint||String(prior.tenantId)!==String(current.tenant._id))throw fail('Funds source reference reused with different movement details',409);return {batch:prior,movements:await Movement.find({batchId:prior._id}).session(session).lean(),journalIds:prior.journalIds,duplicate:true};}
 const occurredAt=value.occurredAt?new Date(value.occurredAt):new Date(),batchId=new mongoose.Types.ObjectId(),accounts=new Map(),updates=[],linesByCurrency=new Map();
 const addLine=(currency,accountCode,side,amountMinor)=>{if(!linesByCurrency.has(currency))linesByCurrency.set(currency,[]);linesByCurrency.get(currency).push({accountCode,side,amountMinor:String(amountMinor)});};
 for(const leg of value.legs){
  const account=await Account.findOneAndUpdate({_id:leg.accountId,tenantId:current.tenant._id,branchId:value.branchId},{$inc:{revision:1}},{session,new:true}).lean();
  if(!account||!canSee(account,current))throw fail('A funds account is unavailable or outside your scope',404);
  if(!current.historicalCorrection)require('../services/branchCurrency.service').resolve(current.operatingBranch,account.currency);
  if(!current.branchTransfer&&!internal.reversesBatchId&&value.sourceType!=='treasury_adjustment'&&account.moduleKey!=='shared'&&!hasModuleForUser(current.tenant,current.operatingActor,account.moduleKey))throw fail('The originating operator no longer has access to this underlying funds module',403);
  if(current.branchTransfer&&account.kind!=='transfer_clearing')throw fail('Only the collected transfer payable can be reclassified',403);
  if(account.operatorId&&String(account.operatorId)!==current.operatingActor.id&&!internal.ownerCapital)throw fail('Use the actual account assigned to the originating operator',403);
  if(account.openingBalanceMinor===null||!account.openingApprovedAt)throw fail(`Independently approve the actual opening balance for ${account.name} first`,409);
  if(account.status!=='active'&&!(internal.allowHeld&&account.status==='held'))throw fail(`${account.name} is held or archived. Reconcile its actual balance first.`,409);
  if(account.reconciliationState!=='matched'&&!internal.allowHeld)throw fail(`${account.name} has an unresolved balance difference`,409);
  if(occurredAt<new Date(account.openingObservedAt))throw fail('This operation predates the reviewed opening. Preserve it as historical evidence rather than counting it twice.',409);
  await assertBookIntegrity(conn,session,account);
  const before=BigInt(String(account.bookBalanceMinor)),delta=BigInt(leg.deltaMinor),after=before+delta;
  if(after<0n&&!internal.allowNegative)throw fail(`Insufficient ${account.currency} funds in ${account.name}`,409);
  if(after>MAX||after< -MAX)throw fail('Funds book exceeds supported exact limits',409);
  if(account.kind==='cash')await require('../services/cashDrawer.service').bindFundAccount(conn,session,account,String(before),{allowNoActiveShift:Boolean(internal.allowSuspense||internal.ownerCapital)});
  const changes={bookBalanceMinor:decimal(after)};
  if(account.lastObservationAt&&occurredAt<=new Date(account.lastObservationAt)){changes.status='held';changes.reconciliationState='stale';changes.lastObservationStale=true;changes.holdReason='A late entry changed a previously reviewed observation. Obtain a new actual balance check.';}
  const changed=await Account.findOneAndUpdate({_id:account._id,revision:account.revision},{$set:changes,$inc:{sequence:1,revision:1}},{session,new:true}).lean();if(!changed)throw fail('Funds account changed concurrently',409);
  if(account.kind==='cash')await require('../services/cashDrawer.service').refreshFundBalance(conn,session,changed,String(after),{allowNoActiveShift:Boolean(internal.allowSuspense||internal.ownerCapital)});
  const chart=await core.ledgerAccountModel(conn).findOne({_id:account.ledgerAccountId,branchId:value.branchId,currency:account.currency,code:account.ledgerCode}).session(session).lean();if(!chart||chart.category!==(account.kind==='transfer_clearing'?'liability':'asset'))throw fail('Funds account ledger mapping is invalid',503);
  accounts.set(String(account._id),account);updates.push({account:changed,delta,balanceAfter:after});addLine(account.currency,account.ledgerCode,delta>0n?normalSide(account.kind):opposite(normalSide(account.kind)),delta<0n?-delta:delta);
 }
 const fundLedgerIds=new Set([...accounts.values()].map(account=>String(account.ledgerAccountId)));
 for(const line of value.ledgerLines){if(!current.historicalCorrection)require('../services/branchCurrency.service').resolve(current.operatingBranch,line.currency);if(fundLedgerIds.has(line.accountId))throw fail('A fund account cannot be supplied again as a counterparty ledger line');const chart=await core.ledgerAccountModel(conn).findOne({_id:line.accountId,branchId:value.branchId,currency:line.currency}).session(session).lean();if(!chart)throw fail('Counterparty ledger account belongs to a different branch or currency',409);addLine(line.currency,chart.code,line.side,BigInt(line.amountMinor));}
 const journalIds=[],journalByCurrency=new Map();
 for(const [currency,raw] of [...linesByCurrency].sort(([a],[b])=>a.localeCompare(b))){
  const grouped=new Map();for(const line of raw){const amount=BigInt(line.amountMinor)*(line.side==='debit'?1n:-1n);grouped.set(line.accountCode,(grouped.get(line.accountCode)||0n)+amount);}
  let lines=[...grouped].filter(([,amount])=>amount!==0n).map(([accountCode,amount])=>({accountCode,side:amount>0n?'debit':'credit',amountMinor:String(amount<0n?-amount:amount)}));
  const net=lines.reduce((sum,line)=>sum+BigInt(line.amountMinor)*(line.side==='debit'?1n:-1n),0n);
  if(net!==0n){if(value.sourceType!=='forex'&&!internal.allowSuspense)throw fail('Funds and counterparty lines must balance exactly in each currency');const counter=await ensureCounterAccount(conn,session,{tenantId:current.tenant._id,branchId:value.branchId,currency,purpose:internal.allowSuspense?'reconciliation_suspense':'settlement_clearing',actorId:current.actor.id});lines.push({accountCode:counter.ledgerCode,side:net>0n?'credit':'debit',amountMinor:String(net<0n?-net:net)});}
  if(!lines.length)continue;
  const journal=current.branchTransfer?await ledger.writeBranchTransferJournalInSession(conn,{branchId:value.branchId,currency,sourceRef:`BRANCH:${internal.branchTransferExecutionId}:ORIGIN`,lines,actorId:current.actor.id,sourceType:'treasury'},session,internal.branchTransferExecutionId,current.tenant,current.actor,{cashierFinal:internal.cashierFinal===true}):await writeTreasuryJournal(conn,session,current,{branchId:value.branchId,currency,sourceRef:`TRS:${batchId}:${currency}`,lines});journalIds.push(journal._id);journalByCurrency.set(currency,journal._id);
 }
 if(updates.some(row=>!journalByCurrency.has(row.account.currency)))throw fail('A fund movement must have a nonzero balanced journal',409);
 const [batch]=await Batch.create([{_id:batchId,tenantId:current.tenant._id,branchId:value.branchId,actorId:current.actor.id,operatingActorId:current.operatingActor.id,sourceType:value.sourceType,sourceRef:value.sourceRef,fingerprint,description:value.description,evidenceReference:value.evidenceReference,occurredAt,journalIds,reversesBatchId:internal.reversesBatchId||null}],{session});
 const movements=updates.length?await Movement.create(updates.map(({account,delta,balanceAfter})=>({tenantId:current.tenant._id,branchId:value.branchId,accountId:account._id,batchId:batch._id,sourceType:value.sourceType,sourceRef:value.sourceRef,sequence:account.sequence,currency:account.currency,deltaMinor:decimal(delta),balanceAfterMinor:decimal(balanceAfter),occurredAt,actorId:current.actor.id,journalId:journalByCurrency.get(account.currency)})),{session,ordered:true}):[];
 await audit(conn,session,current.actor,'treasury.movements.posted',batch._id,{branchId:value.branchId,sourceType:value.sourceType,sourceRef:value.sourceRef,movementCount:movements.length,journalCount:journalIds.length,reversesBatchId:internal.reversesBatchId?String(internal.reversesBatchId):null});
 return {batch,movements,journalIds,duplicate:false};
}
async function postBranchTransferPayout(conn,session,authorization,payoutId,options={}){
 const cashierFinal=options.cashierFinal===true;
 const {execution,source,collection}=await require('../funded/branchTransfer').validate(conn,session,authorization.tenant,authorization.actor,payoutId,{cashierFinal});
 const payable=await ensureCounterAccount(conn,session,{tenantId:authorization.tenant._id,branchId:source.branchId,currency:source.currency,purpose:'interbranch_payable',actorId:authorization.actor.id});
 const receivable=await ensureCounterAccount(conn,session,{tenantId:authorization.tenant._id,branchId:execution.branchId,currency:source.currency,purpose:'interbranch_receivable',actorId:authorization.actor.id});
 const origin=await applyMovements(conn,session,authorization,{sourceType:'money_transfer',sourceRef:`BRANCH_PAYOUT:${execution._id}:ORIGIN`,branchId:String(source.branchId),operatingActorId:String(collection.createdBy),legs:[{accountId:String(collection.accounts.clearingAccountId),deltaMinor:`-${source.amountMinor}`}],ledgerLines:[{currency:source.currency,accountId:String(payable.ledgerAccountId),side:'credit',amountMinor:String(source.amountMinor)}],evidenceRef:execution.evidenceReference,description:execution.note},{branchTransferExecutionId:execution._id,cashierFinal});
 const destination=await applyMovements(conn,session,authorization,{sourceType:'money_transfer',sourceRef:`FUNDED:${execution._id}`,branchId:String(execution.branchId),operatingActorId:String(execution.createdBy),legs:[{accountId:String(execution.accounts.payoutAccountId),deltaMinor:`-${source.amountMinor}`}],ledgerLines:[{currency:source.currency,accountId:String(receivable.ledgerAccountId),side:'debit',amountMinor:String(source.amountMinor)}],evidenceRef:execution.evidenceReference,description:execution.note});
 return {...destination,journalIds:[...origin.journalIds,...destination.journalIds]};
}
async function postCrossCurrencyTransferPayout(conn,session,authorization,execution,source,collection,options={}){
 const cashierFinal=options.cashierFinal===true;
 if(!session?.inTransaction()||execution.action!=='transfer_payout'||!execution.payoutFx)
  throw fail('Cross-currency remittance payout must use one verified transaction',409);
 const fx=execution.payoutFx;
 if(!source||!collection||source.status!=='collected_manual'||
  String(source.manualCollectionExecutionId)!==String(collection._id)||
  collection.status!=='posted_manual'||String(collection.sourceId)!==String(source._id)||
  String(source.currency)===String(fx.targetCurrency)||
  !require('../services/fundedOperations.service').sourceMatches(execution,source))
  throw fail('Collected transfer or cross-currency payout snapshot was changed',409);
 if(new Date(fx.rateExpiresAt)<=new Date())throw fail('Exchange rate has expired. Reject and reissue a payout request at an approved rate.',409);
 const Rate=core.forexRateModel(conn);
 const rate=await Rate.findOne({_id:fx.rateId,branchId:execution.branchId,
   side:'buy',fromCurrency:source.currency,toCurrency:fx.targetCurrency,
   rateDecimal:fx.rateDecimal,status:'active',revision:fx.rateVersion,
   reviewedBy:{$ne:null},expiresAt:{$gt:new Date()}}).session(session).lean();
 if(!rate)throw fail('The approved payout exchange rate was replaced. Request an updated payout.',409);
 const forex=require('../services/forex.service');
 const amount=forex.converted(BigInt(String(source.amountMinor)),source.currency,fx.targetCurrency,
  forex.rateScaled(rate.rateDecimal));
 if(amount!==BigInt(String(fx.payoutMinor)))throw fail('Payout currency calculation or rate snapshot changed',409);
 const sourceBranch=String(source.branchId),targetBranch=String(execution.branchId);
 if(String(source.destinationBranchId||source.branchId)!==targetBranch)
  throw fail('Destination branch was changed after the collection',403);
 const base={sourceType:'forex',sourceRef:'FUNDED:'+execution._id,branchId:targetBranch,
  operatingActorId:String(execution.createdBy),description:'Actual cross-currency PIN remittance cash payout '+source.currency+' to '+fx.targetCurrency,
  evidenceRef:execution.evidenceReference};
 if(sourceBranch===targetBranch){
  return applyMovements(conn,session,authorization,{...base,legs:[
   {accountId:String(collection.accounts.clearingAccountId),deltaMinor:'-'+source.amountMinor},
   {accountId:String(execution.accounts.payoutAccountId),deltaMinor:'-'+fx.payoutMinor}
  ]});
 }
 // Sending and receiving branches must each post their own exact currency.
 // The original transfer payable is settled only through the exact PIN-backed
 // interbranch authorization fence, whether posted by the cashier or legacy reviewer.
 await require('../funded/branchTransfer').validate(conn,session,authorization.tenant,authorization.actor,execution._id,{cashierFinal});
 const payable=await ensureCounterAccount(conn,session,{tenantId:authorization.tenant._id,branchId:source.branchId,
  currency:source.currency,purpose:'interbranch_payable',actorId:authorization.actor.id});
 const receivable=await ensureCounterAccount(conn,session,{tenantId:authorization.tenant._id,branchId:execution.branchId,
  currency:fx.targetCurrency,purpose:'interbranch_receivable',actorId:authorization.actor.id});
 const origin=await applyMovements(conn,session,authorization,{
  sourceType:'money_transfer',sourceRef:'BRANCH_PAYOUT:'+execution._id+':ORIGIN',
  branchId:sourceBranch,operatingActorId:String(collection.createdBy),
  legs:[{accountId:String(collection.accounts.clearingAccountId),deltaMinor:'-'+source.amountMinor}],
  ledgerLines:[{currency:source.currency,accountId:String(payable.ledgerAccountId),side:'credit',amountMinor:String(source.amountMinor)}],
  evidenceRef:execution.evidenceReference,description:execution.note
 },{branchTransferExecutionId:execution._id,cashierFinal});
 const dest=await applyMovements(conn,session,authorization,{...base,
  legs:[{accountId:String(execution.accounts.payoutAccountId),deltaMinor:'-'+fx.payoutMinor}],
  ledgerLines:[{currency:fx.targetCurrency,accountId:String(receivable.ledgerAccountId),
   side:'debit',amountMinor:String(fx.payoutMinor)}]
 });
 return {...dest,journalIds:[...origin.journalIds,...dest.journalIds]};
}
async function reverseMovements(conn,session,authorization,input,internal={}){
 if(!session?.inTransaction())throw fail('Correction must share the business transaction',409);
 const sourceType=input?.sourceType,sourceRef=input?.batchId?null:reference(input?.sourceRef),reversalSourceRef=reference(input?.reversalSourceRef||(input?.batchId?input.sourceRef:null));
 if(internal.momoFx&&(sourceType!=='forex'||!String(input?.sourceRef||'').startsWith('MFX:')))
  throw fail('Invalid linked Mobile Money Forex correction',403);
 const current=await access(conn,authorization.tenant,authorization.actor,{permission:'treasury.review',session,fence:true,sourceType:internal.momoFx?'mobile_money':sourceType});if(!REVIEW_ROLES.includes(current.actor.role))throw fail('Independent funds correction reviewer required',403);
 const batch=await models(conn).batch.findOne({sourceType,...(input.batchId?{_id:oid(input.batchId,'funds batch')}:{sourceRef}),tenantId:current.tenant._id,...scope(current.actor)}).session(session).lean();if(!batch||batch.reversesBatchId)throw fail('Original funds movement is unavailable or already a reversal',409);
 const prior=await models(conn).batch.findOne({reversesBatchId:batch._id}).session(session).lean();if(prior){if(prior.sourceRef!==reversalSourceRef)throw fail('This source has already been corrected',409);return {batch:prior,movements:await models(conn).movement.find({batchId:prior._id}).session(session).lean(),journalIds:prior.journalIds,duplicate:true};}
 if(String(batch.operatingActorId||batch.actorId)===current.actor.id)throw fail('A different person must approve reversal of the original funds entry',403);
 const movements=await models(conn).movement.find({batchId:batch._id}).session(session).lean(),funds=await models(conn).account.find({_id:{$in:movements.map(m=>m.accountId)}}).session(session).lean(),fundIds=new Set(funds.map(account=>String(account.ledgerAccountId)));
 const postings=await core.ledgerPostingModel(conn).find({journalId:{$in:batch.journalIds}}).session(session).lean();
 const ledgerLines=postings.filter(posting=>!fundIds.has(String(posting.accountId))).map(posting=>({currency:posting.currency,accountId:String(posting.accountId),side:opposite(posting.side),amountMinor:String(posting.amountMinor)}));
 const operatorIds=[...new Set(funds.filter(account=>account.operatorId).map(account=>String(account.operatorId)))];if(operatorIds.length>1)throw fail('Correction contains incompatible operating drawers',409);
 return applyMovements(conn,session,current,{sourceType,sourceRef:reversalSourceRef,branchId:String(batch.branchId),operatingActorId:String(batch.operatingActorId||operatorIds[0]||input.operatingActorId||current.actor.id),legs:movements.map(movement=>({accountId:String(movement.accountId),deltaMinor:String(-BigInt(String(movement.deltaMinor)))})),ledgerLines,description:text(input.description,'correction explanation',12,400),evidenceRef:input.evidenceRef||input.evidenceReference||`REV:${batch._id}`},{reversesBatchId:batch._id,allowHeld:true,...(internal.momoFx?{momoFx:true}:{})});
}
async function findAccount(conn,session,{branchId,kind,network='',currency,operatorId=null}){
 if(!KINDS.includes(kind)||!currencyCodes.includes(currency))throw fail('Invalid operating funds account selection');
 const base={branchId:oid(branchId),kind,network:kind==='wallet'?network:'',currency,status:{$ne:'archived'}};
 const owner=operatorId?String(oid(operatorId,'operating staff')):null;
 for(const assignment of owner?[owner,null]:[null]){
  const rows=await models(conn).account.find({...base,operatorId:assignment}).sort({selectionKey:-1,code:1}).limit(3).session(session).lean();
  if(!rows.length)continue;const defaults=rows.filter(account=>account.selectionKey);if(defaults.length===1)return defaults[0];
  if(rows.length===1)return rows[0];throw fail('Multiple actual accounts match this operation. Choose the precise account or configure one default account.',409);
 }
 return null;
}
async function findOperatingAccounts(conn,tenant,actor,{branchId=null,moduleKey=null,currency=null}={},session=null){
 const current=await access(conn,tenant,actor,{sourceType:moduleKey,session}),filter={tenantId:current.tenant._id,status:{$ne:'archived'},...scope(current.actor)};
 if(branchId){if(filter.branchId&&String(filter.branchId)!==String(branchId))throw fail('Cross-branch funds account access denied',403);filter.branchId=oid(branchId);}
 if(currency){if(!currencyCodes.includes(currency))throw fail('Unsupported funds account currency');filter.currency=currency;}
 const rows=await models(conn).account.find(filter).sort({branchId:1,kind:1,code:1}).limit(501).session(session).lean();if(rows.length>500)throw fail('Narrow the funds account branch or currency filters',422);
 return rows.filter(account=>canSee(account,current));
}
async function assertBookIntegrity(conn,session,account){
 if(account.openingBalanceMinor===null)return;
 // Check the chart mapping even when the opening was zero. Matching zero
 // totals must not disguise missing financial ledger account records.
 const chart=await core.ledgerAccountModel(conn).exists({
  _id:account.ledgerAccountId,branchId:account.branchId,currency:account.currency,
  code:account.ledgerCode,category:account.kind==='transfer_clearing'?'liability':'asset'
 }).session(session);
 if(!chart)throw fail('Funds account chart mapping is missing. Preserve opening evidence and reconcile the original journal.',503);
 const entries=await core.ledgerPostingModel(conn).aggregate([{$match:{accountId:account.ledgerAccountId,branchId:account.branchId,currency:account.currency}},{$group:{_id:'$side',amount:{$sum:'$amountMinor'}}}]).session(session);
 let balance=0n;for(const entry of entries)balance+=BigInt(String(entry.amount))*(entry._id===normalSide(account.kind)?1n:-1n);
 const movements=await models(conn).movement.aggregate([{$match:{accountId:account._id}},{$group:{_id:null,amount:{$sum:'$deltaMinor'},count:{$sum:1}}}]).session(session);
 const sum=BigInt(String(account.openingBalanceMinor))+BigInt(String(movements[0]?.amount||'0'));
 if(balance!==BigInt(String(account.bookBalanceMinor))||sum!==balance||Number(movements[0]?.count||0)!==account.sequence)throw fail('Funds book integrity check failed. Suspend transactions and investigate the immutable ledger and movement history.',503);
}
async function balanceSnapshot(conn,tenant,actor,filters={}){
 return transaction(conn,async session=>{
  const accounts=await findOperatingAccounts(conn,tenant,actor,filters,session),rows=[];
  for(const account of accounts){
   // A damaged account must not take every other branch's balance view offline.
   // Display no unverified monetary figures. Posting still fails closed.
   try { await assertBookIntegrity(conn,session,account); }
   catch(error) {
    if(error.status!==503)throw error;
    rows.push({...account,integrityBlocked:true,
     expectedMinor:null,expectedFormatted:'Unavailable — ledger review required',
     observedMinor:null,observedFormatted:'Unavailable',
     varianceMinor:null,varianceFormatted:'—',
     availableMinor:'0',bookKnown:false,pendingObservation:null,
     actualSource:'Account ledger requires administrator reconciliation',
     actualIsLive:false});
    continue;
   }
   const pending=await models(conn).observation.findOne({accountId:account._id,status:'pending_review'}).sort({createdAt:-1}).session(session).lean();
   rows.push({...account,pendingObservation:pending?{id:String(pending._id),actualMinor:String(pending.actualMinor),actualFormatted:format(pending.actualMinor,account.currency),observedAt:pending.observedAt,status:pending.status,evidenceType:pending.evidenceType,varianceMinor:pending.varianceMinorAtRequest===null?null:String(pending.varianceMinorAtRequest)}:null,
    matchedAtLastObservation:account.reconciliationState==='matched',lastReviewedExpectedMinor:account.lastExpectedAtObservationMinor===null?null:String(account.lastExpectedAtObservationMinor),bookKnown:account.openingBalanceMinor!==null,
    expectedMinor:account.openingBalanceMinor===null?null:String(account.bookBalanceMinor),expectedFormatted:account.openingBalanceMinor===null?'Opening not verified':format(account.bookBalanceMinor,account.currency),
    observedMinor:account.lastObservedMinor===null?null:String(account.lastObservedMinor),observedFormatted:account.lastObservedMinor===null?'No verified observation':format(account.lastObservedMinor,account.currency),
    varianceMinor:account.lastVarianceMinor===null?null:String(account.lastVarianceMinor),varianceFormatted:account.lastVarianceMinor===null?'—':format(account.lastVarianceMinor,account.currency),
    availableMinor:account.status==='active'&&account.reconciliationState==='matched'&&BigInt(String(account.bookBalanceMinor))>0n?String(account.bookBalanceMinor):'0',
    actualSource:'independently reviewed manual evidence',actualIsLive:false});
  }
  return {accounts:rows,checkedAt:new Date(),note:'Expected balance is derived from the posted ledger. Actual balance is the last independently reviewed observation at its stated time; it is not a live provider query.'};
 });
}
async function accountDetail(conn,tenant,actor,accountId){
 return transaction(conn,async session=>{
  const authorization=await access(conn,tenant,actor,{session}),account=await loadAccount(conn,authorization,accountId,{session});await assertBookIntegrity(conn,session,account);
  const {observation,movement,batch,adjustment}=models(conn);
  const observations=await observation.find({accountId:account._id}).sort({createdAt:-1,_id:-1}).limit(60).session(session).lean();
  const movements=await movement.find({accountId:account._id}).sort({sequence:-1}).limit(100).session(session).lean();
  const adjustments=await adjustment.find({accountId:account._id}).sort({createdAt:-1}).limit(30).session(session).lean();
  const batches=await batch.find({_id:{$in:movements.map(row=>row.batchId)}}).select('sourceType sourceRef description evidenceReference createdAt reversesBatchId').session(session).lean();
  return {account,observations,movements,adjustments,batches,format};
 });
}
async function reviewQueue(conn,tenant,actor){
 const authorization=await access(conn,tenant,actor,{permission:'treasury.review'});
 const privileged=require('../services/reviewPolicy').canSelfReviewRoutine(authorization.actor,authorization.actor.branchId);
 const observations=await models(conn).observation.find({tenantId:authorization.tenant._id,status:'pending_review',
  ...(privileged?{}:{requestedBy:{$ne:authorization.actor.id}}),...scope(authorization.actor)}).sort({createdAt:1}).limit(101).lean();
 const accountIds=observations.map(row=>row.accountId),accounts=await models(conn).account.find({_id:{$in:accountIds}}).lean(),
  byId=new Map(accounts.filter(account=>canSee(account,authorization)).map(account=>[String(account._id),account]));
 return observations.filter(row=>{
  const account=byId.get(String(row.accountId));if(!account)return false;
  const self=String(row.requestedBy)===authorization.actor.id||String(account.operatorId||'')===authorization.actor.id;
  if(!self)return true;
  return require('../services/reviewPolicy').canSelfReviewRoutine(authorization.actor,account.branchId)&&
   (row.kind==='opening'||(row.kind==='checkpoint'&&row.varianceMinorAtRequest!==null&&
    BigInt(String(row.varianceMinorAtRequest))===0n));
 }).slice(0,100).map(row=>({...row,account:byId.get(String(row.accountId))}));
}
async function requestAdjustment(conn,tenant,actor,observationId,input){
 await ensure(conn);return transaction(conn,async session=>{
  const authorization=await access(conn,tenant,actor,{permission:'treasury.observe',session,fence:true}),observation=await models(conn).observation.findOne({_id:oid(observationId),status:'approved',kind:'checkpoint',tenantId:authorization.tenant._id}).session(session).lean();
  if(!observation||BigInt(String(observation.varianceMinorAtReview||0))===0n)throw fail('Choose an independently reviewed balance discrepancy',409);
  const account=await loadAccount(conn,authorization,observation.accountId,{session,fence:true});if(String(account.lastObservationId)!==String(observation._id)||account.lastObservationStale)throw fail('Obtain a current reviewed observation before proposing an adjustment',409);
  const reason=text(input.reason,'adjustment justification',20,400),idempotencyKey=key(input.idempotencyKey),delta=BigInt(String(observation.varianceMinorAtReview));
  const prior=await models(conn).adjustment.findOne({observationId:observation._id}).session(session).lean();if(prior){if(prior.idempotencyKey===idempotencyKey&&String(prior.requestedBy)===authorization.actor.id&&prior.reason===reason)return {adjustment:prior,duplicate:true};throw fail('An adjustment already exists for this discrepancy',409);}
  const [created]=await models(conn).adjustment.create([{tenantId:authorization.tenant._id,branchId:account.branchId,accountId:account._id,observationId:observation._id,idempotencyKey,deltaMinor:decimal(delta),reason,requestedBy:authorization.actor.id}],{session});
  await audit(conn,session,authorization.actor,'treasury.adjustment.requested',created._id,{branchId:String(account.branchId),accountId:String(account._id),observationId:String(observation._id),deltaMinor:String(delta)});return {adjustment:created,duplicate:false};
 });
}
async function reviewAdjustment(conn,tenant,actor,adjustmentId,input){
 await ensure(conn);return transaction(conn,async session=>{
  const authorization=await access(conn,tenant,actor,{permission:'treasury.review',session,fence:true}),note=text(input.note,'independent adjustment explanation',20,400);if(!['approve','reject'].includes(input.decision))throw fail('Choose approve or reject');
  const adjustment=await models(conn).adjustment.findOne({_id:oid(adjustmentId),tenantId:authorization.tenant._id,status:'pending_review',...scope(authorization.actor)}).session(session).lean();if(!adjustment)throw fail('Adjustment unavailable or already reviewed',409);
  const account=await loadAccount(conn,authorization,adjustment.accountId,{session,fence:true});if(String(adjustment.requestedBy)===authorization.actor.id||String(account.operatorId||'')===authorization.actor.id)throw fail('Adjustment approval requires an independent reviewer',403);
  let batchId=null;
  if(input.decision==='approve'){
   if(String(account.lastObservationId)!==String(adjustment.observationId)||account.lastObservationStale||account.status!=='held')throw fail('A newer or stale observation requires a new reconciliation review',409);
   const original=await models(conn).observation.findById(adjustment.observationId).session(session).lean();if(!original||original.status!=='approved')throw fail('Reviewed discrepancy evidence is missing',409);
   const delta=BigInt(String(adjustment.deltaMinor));
   const result=await applyMovements(conn,session,authorization,{sourceType:'treasury_adjustment',sourceRef:`ADJ:${adjustment._id}`,branchId:String(account.branchId),operatingActorId:String(account.operatorId||authorization.actor.id),legs:[{accountId:account._id,deltaMinor:String(delta)}],description:adjustment.reason,evidenceRef:original.evidenceReference,occurredAt:original.observedAt},{allowHeld:true,allowNegative:account.kind==='bank',allowSuspense:true});batchId=result.batch._id;
   const current=await models(conn).account.findById(account._id).session(session).lean(),expected=await expectedAt(conn,current,new Date(original.observedAt),session);
   if(expected!==BigInt(String(original.actualMinor)))throw fail('Reconciliation adjustment did not match the independently observed balance',503);
   await models(conn).account.updateOne({_id:account._id},{$set:{status:BigInt(String(current.bookBalanceMinor))>=0n?'active':'held',reconciliationState:'matched',lastExpectedAtObservationMinor:decimal(expected),lastVarianceMinor:decimal(0),lastObservationStale:false,holdReason:BigInt(String(current.bookBalanceMinor))<0n?'Negative account balance: settlement and a fresh check are required.':''},$inc:{revision:1}},{session});
  }
  const result=await models(conn).adjustment.findOneAndUpdate({_id:adjustment._id,status:'pending_review'},{$set:{status:input.decision==='approve'?'approved':'rejected',reviewedBy:authorization.actor.id,reviewedAt:new Date(),reviewNote:note,batchId}},{session,new:true});if(!result)throw fail('Adjustment was reviewed concurrently',409);
  await audit(conn,session,authorization.actor,`treasury.adjustment.${input.decision==='approve'?'approved':'rejected'}`,adjustment._id,{branchId:String(account.branchId),accountId:String(account._id),batchId:batchId?String(batchId):null,deltaMinor:String(adjustment.deltaMinor)});return result;
 });
}
module.exports={recordOwnerBalanceCheck,addCapital,postCrossCurrencyTransferPayout,postBranchTransferPayout,models,ensure,access,loadAccount,createAccount,configureAccount,archiveUnusedAccount,restoreArchivedAccount,closeSettledAccount,assertSettledAccountClosable,archiveUnusedWallet,assertUnusedAccountArchivable,assertUnusedWalletArchivable,validateAccount,requestObservation,requestObservationInSession,confirmOwnerOpening,reviewObservation,reviewObservationInSession,applyMovements,reverseMovements,ensureCounterAccount,findAccount,findOperatingAccounts,balanceSnapshot,accountDetail,reviewQueue,requestAdjustment,reviewAdjustment,expectedAt,assertBookIntegrity,format,major,signedMinor,normalizeMovement,parseObservation,scope,moduleForKind,normalSide,fail,KINDS,NETWORKS};
