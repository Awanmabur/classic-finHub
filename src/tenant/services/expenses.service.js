'use strict';
// Expense evidence is retained. Independent approval is required before a cash
// expense affects a verified physical drawer; no provider payment is executed.
const crypto=require('node:crypto');
const {Types}=require('mongoose');
const {expenseModel,ensureExpenseIndexes}=require('../models/expenses');
const {branchModel,cashSessionModel,auditEventModel,tenantUserModel,ensureTenantIndexes}=require('../models');
const Tenant=require('../../platform/models/Tenant');
const {permissionsFor}=require('../../config/roles');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const {hasPermission,hasModuleForUser}=require('./moduleAccess.service');
const mobile=require('./mobileMoney.service');
const cash=require('./cashDrawer.service');
const OID=/^[a-f0-9]{24}$/i,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const supervisors=['Tenant Owner','Branch Manager','Reconciliation Officer','Auditor','Reports Analyst'];
function fail(message,status=400){const error=new Error(message);error.status=status;return error;}
function id(value){if(!OID.test(String(value||'')))throw fail('Invalid identifier');return new Types.ObjectId(String(value));}
function text(value,label,min=0,max=120){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)throw fail(`Invalid ${label}`);return value.trim();}
// Authorization is reconstructed from persisted identity and entitlement. Each
// write also touches those documents in its transaction, so disabling a user,
// changing their branch, or revoking the module cannot race an expense posting.
async function access(conn,tenant,actor,permission,session=null){
 if(!tenant||!tenant.slug||conn.name!==tenantDbNameFromSlug(tenant.slug))throw fail('Tenant database context does not match this workspace',403);
 const tenantFilter={_id:id(tenant._id),slug:tenant.slug,dbName:conn.name,status:{$in:['active','trial']}};
 const current=session?await Tenant.findOneAndUpdate(tenantFilter,{$inc:{__v:1}},{new:true,session}).lean():await Tenant.findOne(tenantFilter).lean();
 if(!current)throw fail('This workspace is unavailable',403);
 const userFilter={_id:id(actor?.id),status:'active'};
 if(session&&Number.isSafeInteger(actor.authVersion))userFilter.authVersion=actor.authVersion===0?{$in:[0,null]}:actor.authVersion;
 const person=session?await tenantUserModel(conn).findOneAndUpdate(userFilter,{$inc:{__v:1}},{new:true,session}).lean():await tenantUserModel(conn).findOne(userFilter).lean();
 if(!person)throw fail('Account access has changed or been revoked',403);
 const trusted={id:String(person._id),name:person.name,role:person.role,authVersion:person.authVersion||0,permissions:permissionsFor(person.role),
  branchId:person.branchId||null,allowedModules:Array.isArray(person.allowedModules)?person.allowedModules:[]};
 if(!hasModuleForUser(current,trusted,'expenses')||!hasPermission(trusted,permission))throw fail('Expenses module and role permission required',403);
 if(!['Tenant Owner','Auditor'].includes(trusted.role)){
  const active=session?await branchModel(conn).findOneAndUpdate({_id:id(trusted.branchId),status:'active'},{$inc:{revision:1}},{new:true,session}):await branchModel(conn).exists({_id:id(trusted.branchId),status:'active'});
  if(!active)throw fail('An active branch assignment is required',403);
 }
 return {actor:session?trusted:require('./branchView.service').withReadView(trusted,actor),tenant:current};
}
function scopeFor(actor){
 if(['Tenant Owner','Auditor'].includes(actor?.role))return require('./branchView.service').readScope(actor);
 if(!OID.test(String(actor?.branchId||'')))throw fail('An active branch assignment is required',403);
 return {branchId:id(actor.branchId),...(!supervisors.includes(actor.role)?{operatorId:id(actor.id)}:{})};
}
function values(input,currency){return {expenseType:text(input.expenseType,'expense type',2,100),amountMinor:mobile.toMinor(input.amount,currency),
 vendor:text(input.vendor??'','vendor',0,120),reference:text(input.reference??'','reference',0,120),description:text(input.description??'','description',0,400)};}
function snapshot(record){return {expenseType:record.expenseType,amountMinor:String(record.amountMinor),vendor:record.vendor||'',reference:record.reference||'',description:record.description||''};}
function same(existing,actor,branchId,value,method,treasuryAccountId=null){return String(existing.operatorId)===String(actor.id)&&String(existing.branchId)===String(branchId)&&
 existing.paymentMethod===method&&String(existing.treasuryAccountId||'')===String(treasuryAccountId||'')&&Object.keys(value).every(key=>String(existing.original[key])===String(value[key]));}
function fundId(value){if(value===undefined||value===null||value==='')return null;if(typeof value!=='string')throw fail('Choose a valid funds account');return id(value);}
function fundKind(method){return {Cash:'cash','Mobile Money':'wallet',Bank:'bank'}[method]||null;}
async function hasFunds(conn,tenant,branchId,currency,method,session=null){
 const query=require('../treasury/models').models(conn).account.exists({tenantId:tenant._id,branchId,currency,kind:fundKind(method),status:{$ne:'archived'}});
 if(session)query.session(session);return !!await query;
}
async function validateRequestedFund(conn,session,tenant,actor,branch,paymentMethod,accountId){
 if(!accountId)return;
 const account=await require('../treasury/models').models(conn).account.findOne({_id:accountId,tenantId:tenant._id,branchId:branch._id,currency:branch.currency,
  kind:fundKind(paymentMethod),status:{$ne:'archived'},$or:[{operatorId:null},{operatorId:id(actor.id)}]}).session(session).lean();
 if(!account||!visibleFund(account,tenant,actor,actor.id)||paymentMethod==='Cash'&&String(account.operatorId)!==String(actor.id))throw fail('Choose your actual funds account in this branch, currency and payment method',403);
}
function visibleFund(account,tenant,actor,operatorId){
 const moduleKey=account.moduleKey||'shared';
 return (!account.operatorId||String(account.operatorId)===String(operatorId))&&
  (moduleKey==='shared'||hasModuleForUser(tenant,actor,moduleKey));
}
// Selection is informational until review. A fund without a reviewed opening,
// or a held/mismatching fund, is never presented as spendable money.
async function fundChoices(conn,tenant,actor,{expenseId=null}={}){
 ({actor,tenant}=await access(conn,tenant,actor,'expenses.view'));
 let branchId,currency,operatorId=actor.id;
 if(expenseId){
  const record=await expenseModel(conn).findOne({_id:id(expenseId),...scopeFor(actor)}).lean();
  if(!record)throw fail('Expense not found within your permissions',404);
  if(String(record.operatorId)!==actor.id&&!hasPermission(actor,'expenses.review'))throw fail('Independent expense review permission required',403);
  branchId=record.branchId;currency=record.currency;operatorId=String(record.operatorId);
 }else{
  if(!hasPermission(actor,'expenses.create'))return [];
  let branch;try{branch=await require('./transactionBranch.service').resolveTransactionBranch(conn,actor,{});}catch(error){if([403,409].includes(error.status))return [];throw error;}
  branchId=branch._id;currency=branch.currency;
 }
 const rows=await require('../treasury/models').models(conn).account.find({tenantId:tenant._id,branchId,currency,
  kind:{$in:['cash','wallet','bank']},status:'active',openingBalanceMinor:{$ne:null},
  $or:[{operatorId:null},{operatorId:id(operatorId)}]}).select('_id name kind moduleKey network currency operatorId bookBalanceMinor reconciliationState').sort({kind:1,name:1,_id:1}).limit(200).lean();
 return rows.filter(row=>visibleFund(row,tenant,actor,operatorId)).map(row=>({_id:String(row._id),name:row.name,kind:row.kind,network:row.network||'',currency:row.currency,
  balance:mobile.formatMoneyMinor(row.bookBalanceMinor,row.currency),reconciliationState:row.reconciliationState}));
}
async function requiresBook(conn,tenant,record,session){
 if(record.treasuryBatchId||record.sourcePolicy==='funded_required'||record.treasuryAccountId||record.postedTreasuryAccountId)return true;
 if(record.cashSessionId){const shift=await cashSessionModel(conn).findById(record.cashSessionId).select('treasuryAccountId').session(session).lean();if(shift?.treasuryAccountId)return true;}
 return hasFunds(conn,tenant,record.branchId,record.currency,record.paymentMethod,session);
}
async function postingAuthorization(conn,session,tenant,actor){
 return require('../treasury/service').access(conn,tenant,actor,{permission:'expenses.review',session,fence:true,sourceType:'expenses'});
}
async function resolveFund(conn,session,authorization,record,input={}){
 const requested=fundId(input.treasuryAccountId),fixed=record.postedTreasuryAccountId||record.treasuryAccountId;
 if(requested&&fixed&&String(requested)!==String(fixed))throw fail('An expense funds source cannot be changed after it was selected',409);
 let selected=fixed||requested;
 if(!selected&&record.cashSessionId){const shift=await cashSessionModel(conn).findById(record.cashSessionId).select('treasuryAccountId').session(session).lean();selected=shift?.treasuryAccountId;}
 const Treasury=require('../treasury/models').models(conn).account;
 if(!selected){
  const matches=await Treasury.find({tenantId:authorization.tenant._id,branchId:record.branchId,currency:record.currency,kind:fundKind(record.paymentMethod),
   status:'active',openingBalanceMinor:{$ne:null},$or:[{operatorId:null},{operatorId:record.operatorId}]}).select('_id moduleKey operatorId').limit(3).session(session).lean();
  const visible=matches.filter(row=>visibleFund(row,authorization.tenant,authorization.actor,record.operatorId));
  if(visible.length!==1)throw fail('Choose the actual funds account and obtain its independent opening approval before approving this expense',409);
  selected=visible[0]._id;
 }
 const account=await require('../treasury/service').loadAccount(conn,authorization,selected,{session,fence:true});
 if(String(account.branchId)!==String(record.branchId)||account.currency!==record.currency||account.kind!==fundKind(record.paymentMethod)||
  account.operatorId&&String(account.operatorId)!==String(record.operatorId)||record.paymentMethod==='Cash'&&String(account.operatorId)!==String(record.operatorId))
  throw fail('Choose the actual expense maker funds account in the same branch, currency and payment method',409);
 if(account.status!=='active'||account.openingBalanceMinor===null)throw fail('This funds account needs an independently approved opening or reconciliation before posting',409);
 return account;
}
async function postExpense(conn,session,authorization,record,account,sequence){
 const treasury=require('../treasury/service'),counter=await treasury.ensureCounterAccount(conn,session,{tenantId:authorization.tenant._id,
  branchId:record.branchId,currency:record.currency,purpose:'expense',actorId:authorization.actor.id});
 const amount=String(record.amountMinor);
 return treasury.applyMovements(conn,session,authorization,{sourceType:'expenses',sourceRef:`${record._id}:expense:${sequence}`,branchId:record.branchId,operatingActorId:String(record.operatorId),
  legs:[{accountId:account._id,deltaMinor:'-'+amount}],ledgerLines:[{currency:record.currency,accountId:counter.ledgerAccountId,side:'debit',amountMinor:amount}],
  description:`Expense ${record.recordReference}: ${record.expenseType}`.slice(0,400),evidenceReference:record.reference||record.recordReference,occurredAt:new Date()});
}
function postedBatchId(result){return id(result?.batch?._id||result?._id||result?.batchId);}
async function reverseExpense(conn,session,authorization,record,sequence,note){
 return require('../treasury/service').reverseMovements(conn,session,authorization,{sourceType:'expenses',sourceRef:`${record._id}:expense:${record.postingSequence||1}`,reversalSourceRef:`${record._id}:expense-reversal:${sequence}`,description:`Expense ${record.recordReference} correction: ${note}`.slice(0,400),
  evidenceReference:record.reference||record.recordReference,occurredAt:new Date()});
}
async function ready(conn){await ensureTenantIndexes(conn);await ensureExpenseIndexes(conn);}
async function audit(conn,session,actor,record,action){await auditEventModel(conn).create([{action:`expenses.${action}`,actorId:id(actor.id),targetId:record._id,
 metadata:{branchId:String(record.branchId),currency:record.currency,recordReference:record.recordReference,status:record.status,amountMinor:String(record.amountMinor),
  treasuryAccountId:record.postedTreasuryAccountId?String(record.postedTreasuryAccountId):null,treasuryBatchId:record.treasuryBatchId?String(record.treasuryBatchId):null,
  reversalBatchId:record.lastReversalBatchId?String(record.lastReversalBatchId):null}}],{session});}
async function shiftFence(conn,session,record,offset=0n,{bookManaged=false}={}){
 if(record.paymentMethod!=='Cash')return;
 const branch=await branchModel(conn).findOneAndUpdate({_id:record.branchId,status:'active',currency:record.currency},{$inc:{revision:1}},{new:true,session});
 if(!branch)throw fail('The linked cash branch is inactive or unavailable',409);
 const prior=await cashSessionModel(conn).findOne({_id:record.cashSessionId,branchId:record.branchId,operatorId:record.operatorId}).session(session).lean();
 if(!bookManaged&&offset!==0n&&prior?.treasuryAccountId)throw fail('This historical expense has no funds-book posting. Reconcile its original evidence before changing the managed cash drawer.',409);
 const shift=await cashSessionModel(conn).findOneAndUpdate({_id:record.cashSessionId,branchId:record.branchId,operatorId:record.operatorId,
  currency:record.currency,status:{$in:['open','disputed']},openingVerifiedAt:{$ne:null}},
  {$inc:{revision:1,provisionalMovementMinor:cash.decimal(bookManaged?0n:offset)}},{new:true,session});
 if(!shift)throw fail('Cash shift is no longer editable. Dispute a submitted shift before correcting its expenses.',409);
 if(cash.minor(shift.openingMinor)+cash.minor(shift.provisionalMovementMinor)<0n)throw fail('Insufficient recorded physical cash for this expense',409);
 return shift;
}
async function create(conn,tenant,actor,input={},options={}){
 ({actor,tenant}=await access(conn,tenant,actor,'expenses.create'));id(actor.id);
 const branch=await require('./transactionBranch.service').resolveTransactionBranch(conn,actor,input),value=values(input,branch.currency);
 if(input.currency&&input.currency!==branch.currency)throw fail('Expense currency must match your operating branch',409);
 const paymentMethod=text(input.paymentMethod,'payment method',4,20),requestedFundId=fundId(input.treasuryAccountId);
 const sourcePolicy=options.requireFunds===true||requestedFundId||await hasFunds(conn,tenant,branch._id,branch.currency,paymentMethod)?'funded_required':'legacy_untracked';
 if(!['Cash','Mobile Money','Bank'].includes(paymentMethod))throw fail('Invalid expense payment method');
 if(!UUID.test(String(input.idempotencyKey||'')))throw fail('Reload the form to generate a valid form reference');
 await ready(conn);if(sourcePolicy==='funded_required')await require('../treasury/models').ensure(conn);const Model=expenseModel(conn),branchId=branch._id;
 const existing=await Model.findOne({idempotencyKey:input.idempotencyKey}).lean();
 if(existing){if(!same(existing,actor,branchId,value,paymentMethod,requestedFundId))throw fail('Form reference already used with different details',409);return {record:existing,duplicate:true};}
 const session=await conn.startSession();let record;
 try{await session.withTransaction(async()=>{
  ({actor,tenant}=await access(conn,tenant,actor,'expenses.create',session));
  const verifiedBranch=await require('./transactionBranch.service').resolveTransactionBranch(conn,actor,input);
  if(String(verifiedBranch._id)!==String(branchId)||verifiedBranch.currency!==branch.currency)throw fail('Operating branch changed. Refresh and retry.',409);
  const active=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'active',currency:branch.currency},{$inc:{revision:1}},{new:true,session});
  if(!active)throw fail('Operating branch is unavailable',409);
  await validateRequestedFund(conn,session,tenant,actor,branch,paymentMethod,requestedFundId);
  let cashSessionId=null;
  if(paymentMethod==='Cash'){
   const shift=await cashSessionModel(conn).findOneAndUpdate({activeKey:cash.key(branchId,actor.id),currency:branch.currency,status:'open',openingVerifiedAt:{$ne:null}},
    {$inc:{revision:1}},{new:true,session});
   if(!shift)throw fail('Cash expenses require your independently verified open cash shift. Pending expenses do not reduce cash.',409);
   cashSessionId=shift._id;
  }
  await require('../../platform/services/commercial.service').reserveUsage(tenant,'expenses',session);
  [record]=await Model.create([{...value,branchId,operatorId:actor.id,currency:branch.currency,paymentMethod,cashSessionId,treasuryAccountId:requestedFundId,sourcePolicy,
   original:value,idempotencyKey:input.idempotencyKey,recordReference:`EXP-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
   history:[{action:'created',actorId:actor.id,at:new Date(),after:value,note:'Submitted for independent review'}]}],{session});
  await audit(conn,session,actor,record,'created');
 });return {record,duplicate:false};}
 catch(error){if(error.code===11000){const found=await Model.findOne({idempotencyKey:input.idempotencyKey}).lean();
  if(found&&same(found,actor,branchId,value,paymentMethod,requestedFundId))return {record:found,duplicate:true};throw fail('Expense form reference already used',409);}throw error;}
 finally{await session.endSession();}
}
async function review(conn,tenant,actor,expenseId,input={}){
 ({actor,tenant}=await access(conn,tenant,actor,'expenses.review'));if(!['approve','reject'].includes(input.decision))throw fail('Invalid expense decision');
 const reason=text(input.note,'review explanation',12,400);await ready(conn);const session=await conn.startSession();let record;
 try{await session.withTransaction(async()=>{
  ({actor,tenant}=await access(conn,tenant,actor,'expenses.review',session));
  const old=await expenseModel(conn).findOne({_id:id(expenseId),...scopeFor(actor)}).session(session).lean();
  if(!old)throw fail('Expense not found within your permissions',404);
  if(String(old.operatorId)===String(actor.id))throw fail('A different authorized person must review this expense',403);
  if(old.status!=='pending_review'||old.pendingChange)throw fail('Expense was reviewed or has an unresolved correction',409);
  const funded=input.decision==='approve'&&await requiresBook(conn,tenant,old,session);let posting={},batchId=null;
  if(funded){
   const authorization=await postingAuthorization(conn,session,tenant,actor),account=await resolveFund(conn,session,authorization,old,input);
   await shiftFence(conn,session,old,0n,{bookManaged:true});
   batchId=postedBatchId(await postExpense(conn,session,authorization,old,account,1));
   posting={postedTreasuryAccountId:account._id,treasuryBatchId:batchId,postingSequence:1};
  }else await shiftFence(conn,session,old,input.decision==='approve'?-cash.minor(old.amountMinor):0n);
  record=await expenseModel(conn).findOneAndUpdate({_id:old._id,revision:old.revision,status:'pending_review'},{$set:{
   status:input.decision==='approve'?'approved':'rejected',reviewedBy:id(actor.id),reviewedAt:new Date(),reviewNote:reason,...posting},
   $inc:{revision:1},$push:{history:{action:input.decision==='approve'?'approved':'rejected',actorId:id(actor.id),at:new Date(),note:reason,treasuryBatchId:batchId}}},{new:true,session});
  if(!record)throw fail('Expense changed concurrently',409);await audit(conn,session,actor,record,record.status);
 });return record;}finally{await session.endSession();}
}
async function requestChange(conn,tenant,actor,expenseId,input={},kind='correct'){
 if(!['correct','void'].includes(kind))throw fail('Invalid correction kind');({actor,tenant}=await access(conn,tenant,actor,`expenses.${kind}`));
 const reason=text(input.note,'correction explanation',12,400);await ready(conn);const session=await conn.startSession();let record;
 try{await session.withTransaction(async()=>{
  ({actor,tenant}=await access(conn,tenant,actor,`expenses.${kind}`,session));
  const old=await expenseModel(conn).findOne({_id:id(expenseId),...scopeFor(actor)}).session(session).lean();
  if(!old)throw fail('Expense not found within your permissions',404);
  if(!['pending_review','approved'].includes(old.status)||old.pendingChange)throw fail('Expense is not available for correction',409);
  if((old.history||[]).filter(h=>h.action.endsWith('_requested')).length>=10)throw fail('Correction limit reached; contact your supervisor',409);
  if(input.currency&&input.currency!==old.currency||input.paymentMethod&&input.paymentMethod!==old.paymentMethod)throw fail('Currency and payment method are historical and cannot be changed',409);
  const proposed=kind==='correct'?values(input,old.currency):null;
  await shiftFence(conn,session,old);
  record=await expenseModel(conn).findOneAndUpdate({_id:old._id,revision:old.revision},{$set:{correctionState:'requested',pendingChange:{
   kind,requestedBy:id(actor.id),requestedAt:new Date(),reason,values:proposed}},$inc:{revision:1},
   $push:{history:{action:`${kind}_requested`,actorId:id(actor.id),at:new Date(),note:reason,before:snapshot(old),after:proposed}}},{session,new:true});
  if(!record)throw fail('Expense changed concurrently',409);await audit(conn,session,actor,record,`${kind}_requested`);
 });return record;}finally{await session.endSession();}
}
async function decideChange(conn,tenant,actor,expenseId,input={}){
 ({actor,tenant}=await access(conn,tenant,actor,'expenses.review'));if(!['approve','deny'].includes(input.decision))throw fail('Invalid correction decision');
 const reason=text(input.note,'correction review explanation',12,400);await ready(conn);const session=await conn.startSession();let record;
 try{await session.withTransaction(async()=>{
  ({actor,tenant}=await access(conn,tenant,actor,'expenses.review',session));
  const old=await expenseModel(conn).findOne({_id:id(expenseId),...scopeFor(actor)}).session(session).lean(),pending=old?.pendingChange;
  if(!old)throw fail('Expense not found within your permissions',404);
  if(!pending||old.correctionState!=='requested')throw fail('No pending expense correction',409);
  if([String(old.operatorId),String(pending.requestedBy)].includes(String(actor.id)))throw fail('A different authorized person must decide this correction',403);
  const approved=input.decision==='approve',isVoid=pending.kind==='void';let offset=0n,batchId=null,reversalId=null;
  const set={correctionState:approved?'applied':'denied',pendingChange:null};
  if(approved&&old.status==='approved'&&old.treasuryBatchId){
   const authorization=await postingAuthorization(conn,session,tenant,actor),sequence=(old.postingSequence||0)+1;
   await shiftFence(conn,session,old,0n,{bookManaged:true});
   reversalId=postedBatchId(await reverseExpense(conn,session,authorization,old,sequence,reason));
   if(!isVoid){
    const account=await resolveFund(conn,session,authorization,old,{});
    batchId=postedBatchId(await postExpense(conn,session,authorization,{...old,...snapshot(pending.values)},account,sequence));
   }
   Object.assign(set,{treasuryBatchId:batchId,lastReversalBatchId:reversalId,postingSequence:sequence});
  }else{
   if(approved&&old.status==='approved')offset=isVoid?cash.minor(old.amountMinor):cash.minor(old.amountMinor)-cash.minor(pending.values.amountMinor);
   await shiftFence(conn,session,old,offset);
  }
  if(approved&&isVoid)set.status='voided';
  if(approved&&!isVoid)Object.assign(set,snapshot(pending.values));
  record=await expenseModel(conn).findOneAndUpdate({_id:old._id,revision:old.revision,correctionState:'requested'},{$set:set,$inc:{revision:1},
   $push:{history:{action:`${pending.kind}_${approved?'approved':'denied'}`,actorId:id(actor.id),at:new Date(),note:reason,before:snapshot(old),
    after:approved&&!isVoid?snapshot(pending.values):null,treasuryBatchId:batchId,reversalBatchId:reversalId}}},{session,new:true});
  if(!record)throw fail('Expense changed concurrently',409);await audit(conn,session,actor,record,`${pending.kind}_${approved?'approved':'denied'}`);
 });return record;}finally{await session.endSession();}
}
async function list(conn,tenant,actor,query={}){
 ({actor,tenant}=await access(conn,tenant,actor,'expenses.view'));const filters={from:String(query.from||''),to:String(query.to||''),status:String(query.status||'all')};
 if(!['all','pending_review','approved','rejected','voided'].includes(filters.status))throw fail('Invalid expense status');
 const match={...scopeFor(actor),createdAt:mobile.dateBounds(filters)};
 if(filters.status!=='all')match.status=filters.status;
 const position=mobile.decodeCursor(query.cursor);
 if(position)match.$or=[{createdAt:{$lt:position.at}},{createdAt:position.at,_id:{$lt:id(position.id)}}];
 const all=await expenseModel(conn).find(match).sort({createdAt:-1,_id:-1}).limit(41).maxTimeMS(5000).lean(),items=all.slice(0,40);
 return {items,filters,nextCursor:all.length>40?mobile.encodeCursor(items.at(-1)):null};
}
async function detail(conn,tenant,actor,expenseId){
 ({actor,tenant}=await access(conn,tenant,actor,'expenses.view'));const record=await expenseModel(conn).findOne({_id:id(expenseId),...scopeFor(actor)}).lean();
 if(!record)throw fail('Expense not found within your permissions',404);return record;
}
async function reportRows({conn,filters,scope={}}){
 const match={createdAt:mobile.dateBounds(filters),...require('../reporting/aggregateScope').branchMatch(scope,id)};
 if(scope.operatorId)match.operatorId=id(scope.operatorId);
 const rows=await expenseModel(conn).aggregate([{$match:match},{$group:{_id:{currency:'$currency',status:'$status',method:'$paymentMethod'},
  count:{$sum:1},amount:{$sum:'$amountMinor'}}},{$sort:{'_id.currency':1,'_id.status':1,'_id.method':1}}]).option({maxTimeMS:5000});
 return rows.map(row=>({module:'Expenses',activity:row._id.method,status:row._id.status,currency:row._id.currency,count:row.count,
  amountMinor:String(row.amount),volume:mobile.formatMoneyMinor(row.amount,row._id.currency),fees:'N/A'}));
}
function csv(records){return '\uFEFF'+[['Recorded (UTC)','Expense record','Type','Currency','Amount minor units','Amount','Method','Vendor','Reference','Description','Status','Correction'],
 ...records.map(record=>[new Date(record.createdAt).toISOString(),record.recordReference,record.expenseType,record.currency,String(record.amountMinor),
  mobile.formatMoneyMinor(record.amountMinor,record.currency),record.paymentMethod,record.vendor,record.reference,record.description,record.status,record.correctionState])]
 .map(row=>row.map(mobile.csvCell).join(',')).join('\r\n')+'\r\n';}
module.exports={access,create,review,requestChange,decideChange,list,detail,reportRows,csv,scopeFor,values,snapshot,shiftFence,fundChoices,fundKind,fundId};
