'use strict';
const mongoose=require('mongoose');
const Tenant=require('../../platform/models/Tenant');
const models=require('../models');
const directory=require('./models');
const v=require('./validation');
const {permissionsFor}=require('../../config/roles');
const {hasModuleForUser,hasPermission,assignableModules}=require('../services/moduleAccess.service');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const {resolveTransactionBranch}=require('../services/transactionBranch.service');
const {reserveUsage}=require('../../platform/services/commercial.service');
const {currencyOptions,currencyLabel}=require('../../config/currencies');
const branchCurrency=require('../services/branchCurrency.service');
const oid=x=>new mongoose.Types.ObjectId(String(x));
async function context(conn,tenant,actor,moduleKey,permission,session=null){
 if(!tenant||conn.name!==tenantDbNameFromSlug(tenant.slug))throw v.fail('Tenant database context does not match this account',403);
 const criteria={_id:v.id(tenant._id),slug:tenant.slug,status:{$in:['active','trial']}};
 const currentTenant=await (session?Tenant.findOneAndUpdate(criteria,{$inc:{__v:1}},{session,new:true}):Tenant.findOne(criteria)).lean();
 if(!currentTenant||conn.name!==tenantDbNameFromSlug(currentTenant.slug))throw v.fail('Workspace access has been revoked',403);
 const person=await (session?models.tenantUserModel(conn).findOneAndUpdate({_id:v.id(actor?.id),status:'active'},{$inc:{__v:1}},{session,new:true}):models.tenantUserModel(conn).findOne({_id:v.id(actor?.id),status:'active'})).lean();
 if(!person)throw v.fail('Account access has been revoked',403);
 const trusted={id:String(person._id),name:person.name,role:person.role,permissions:permissionsFor(person.role),branchId:person.branchId||null,allowedModules:person.allowedModules===undefined?assignableModules(currentTenant,person.role):person.allowedModules,authVersion:person.authVersion||0};
 if(!hasModuleForUser(currentTenant,trusted,moduleKey)||!hasPermission(trusted,permission))throw v.fail('This module or action is not assigned to your account',403);
 if(!['Tenant Owner','Auditor'].includes(trusted.role)){
  const branchQuery=models.branchModel(conn).exists({_id:v.id(trusted.branchId),status:'active'});
  if(session)branchQuery.session(session);
  if(!await branchQuery)throw v.fail('An active assigned branch is required',403);
 }
 return {actor:session?trusted:require('../services/branchView.service').withReadView(trusted,actor),tenant:currentTenant};
}
async function access(conn,tenant,actor,moduleKey,permission){return (await context(conn,tenant,actor,moduleKey,permission)).actor;}
async function fenceAccess(conn,session,tenant,actor,moduleKey,permission){
 const current=await context(conn,tenant,actor,moduleKey,permission,session);
 if(['role','branchId','authVersion'].some(key=>String(actor[key]??'')!==String(current.actor[key]??'')))throw v.fail('Account assignment changed. Reload before saving.',409);
 return current;
}
function scope(actor){return ['Tenant Owner','Auditor'].includes(actor.role)?require('../services/branchView.service').readScope(actor):{branchId:v.id(actor.branchId)};}
function queryScope(actor){const s=scope(actor);return s.branchId?{branchId:oid(s.branchId)}:{};}
async function prepare(conn){await Promise.all([models.ensureTenantIndexes(conn),directory.ensureIndexes(conn)]);}
async function transaction(conn,run){const session=await conn.startSession();try{let result;await session.withTransaction(async()=>{result=await run(session);});return result;}finally{await session.endSession();}}
async function audit(conn,session,actor,record,action){await models.auditEventModel(conn).create([{action,actorId:actor.id,targetId:record._id,metadata:{branchId:String(record.branchId),revision:record.revision||0}}],{session});}
async function fenceBranch(conn,session,branchId){const branch=await models.branchModel(conn).findOneAndUpdate({_id:branchId,status:'active'},{$inc:{revision:1}},{session,new:true});if(!branch)throw v.fail('Your operating branch is unavailable',409);return branch;}
function same(record,actor,branchId,value){return String(record.createdBy)===actor.id&&String(record.branchId)===String(branchId)&&Object.entries(value).every(([key,val])=>String(record[key]??'')===String(val??''));}
async function customerCreate(conn,tenant,actor,input){
 actor=await access(conn,tenant,actor,'customers','customers.create');const value=v.customer(input),key=v.key(input.idempotencyKey);
 const branchId=String((await resolveTransactionBranch(conn,actor,input))._id);await prepare(conn);
 const Model=directory.customerModel(conn),lookup=()=>Model.findOne({idempotencyKey:key}).lean();
 const replay=async()=>{const old=await lookup();if(!old)return null;if(!same(old,actor,branchId,value)||(input.reference&&old.reference!==v.reference(input.reference,'CUS')))throw v.fail('Creation reference was already used with different details',409);return {record:old,duplicate:true};};
 const existing=await replay();if(existing)return existing;
 try{return await transaction(conn,async session=>{const current=await fenceAccess(conn,session,tenant,actor,'customers','customers.create');await fenceBranch(conn,session,branchId);await reserveUsage(current.tenant,'customers',session);
  const [record]=await Model.create([{...value,reference:v.reference(input.reference,'CUS'),idempotencyKey:key,branchId,createdBy:actor.id,updatedBy:actor.id}],{session});
  await audit(conn,session,actor,record,'customer.created');return {record,duplicate:false};
 });}catch(e){if(e.code===11000){const old=await replay();if(old)return old;throw v.fail('Customer reference is already in use',409);}throw e;}
}
async function customerUpdate(conn,tenant,actor,customerId,input){
 actor=await access(conn,tenant,actor,'customers','customers.manage');const value=v.customer(input),revision=v.revision(input.revision);await prepare(conn);
 return transaction(conn,async session=>{await fenceAccess(conn,session,tenant,actor,'customers','customers.manage');const record=await directory.customerModel(conn).findOneAndUpdate({_id:v.id(customerId),...scope(actor),status:'active',revision},{$set:{...value,updatedBy:actor.id},$inc:{revision:1}},{session,new:true,runValidators:true});
  if(!record)throw v.fail('Customer was changed, archived or is outside your branch. Reload before editing.',409);
  if(input.reference&&record.reference!==input.reference)throw v.fail('Customer reference cannot be changed',409);
  await audit(conn,session,actor,record,'customer.updated');return record;
 });
}
async function customerArchive(conn,tenant,actor,customerId,input={}){
 actor=await access(conn,tenant,actor,'customers','customers.manage');await prepare(conn);
 return transaction(conn,async session=>{await fenceAccess(conn,session,tenant,actor,'customers','customers.manage');const record=await directory.customerModel(conn).findOneAndUpdate({_id:v.id(customerId),...scope(actor),status:'active',revision:v.revision(input.revision)},{$set:{status:'archived',archivedAt:new Date(),updatedBy:actor.id},$inc:{revision:1}},{session,new:true});
  if(!record)throw v.fail('Customer was changed, archived or is outside your branch',409);
  if(await directory.accountModel(conn).exists({customerId:record._id,status:{$ne:'closed'}}).session(session))throw v.fail('Close the customer’s open accounts before archiving the profile',409);
  await audit(conn,session,actor,record,'customer.archived');return record;
 });
}
function search(input){const q=v.text(input||'','search',0,100);if(!q)return {};const escaped=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return {$or:[{normalizedName:new RegExp('^'+escaped,'i')},{phone:new RegExp('^'+escaped)},{reference:new RegExp('^'+escaped,'i')}]};}
async function customerList(conn,tenant,actor,input={}){
 const trusted=await context(conn,tenant,actor,'customers','customers.view');actor=trusted.actor;tenant=trusted.tenant;await prepare(conn);const base={...scope(actor),status:input.status==='archived'?'archived':'active'},filter={$and:[base,search(input.q),v.pageFilter(input.cursor)]};
 const rows=await directory.customerModel(conn).find(filter).sort({createdAt:-1,_id:-1}).limit(26).lean(),more=rows.length>25,items=rows.slice(0,25);
 const canViewAccounts=hasModuleForUser(tenant,actor,'accounts')&&hasPermission(actor,'accounts.view');
 const [counts,total,accounts]=await Promise.all([canViewAccounts?directory.accountModel(conn).aggregate([{$match:{...queryScope(actor),customerId:{$in:items.map(x=>x._id)}}},{$group:{_id:'$customerId',count:{$sum:1}}}]):[],directory.customerModel(conn).countDocuments(base),canViewAccounts?directory.accountModel(conn).countDocuments({...scope(actor),status:{$ne:'closed'}}):null]);
 const byId=new Map(counts.map(x=>[String(x._id),x.count]));items.forEach(x=>x.accountCount=canViewAccounts?(byId.get(String(x._id))||0):null);
 return {items,nextCursor:more?v.nextCursor(items):null,total,accounts,canViewAccounts,q:v.text(input.q||'','search',0,100),status:base.status,actor};
}
async function customerDetail(conn,tenant,actor,customerId){
 actor=await access(conn,tenant,actor,'customers','customers.view');await prepare(conn);const record=await directory.customerModel(conn).findOne({_id:v.id(customerId),...scope(actor)}).lean();if(!record)throw v.fail('Customer not found in your permitted branch',404);return record;
}
async function customerChoices(conn,tenant,actor,input={}){actor=await access(conn,tenant,actor,'accounts','accounts.manage');await prepare(conn);const branch=await resolveTransactionBranch(conn,actor);return directory.customerModel(conn).find({$and:[{branchId:branch._id,status:'active'},search(input.q)]}).select('name phone reference branchId').sort({normalizedName:1,_id:1}).limit(50).lean();}
async function accountCreate(conn,tenant,actor,input){
 actor=await access(conn,tenant,actor,'accounts','accounts.manage');const value=v.account(input),customerId=v.id(input.customerId),key=v.key(input.idempotencyKey);if(value.status==='closed')throw v.fail('A new account cannot start closed');
 const operatingBranch=await resolveTransactionBranch(conn,actor,input),branchId=String(operatingBranch._id),currency=branchCurrency.resolve(operatingBranch,input.currency);await prepare(conn);const Model=directory.accountModel(conn);
 const replay=async()=>{const record=await Model.findOne({idempotencyKey:key}).lean();if(!record)return null;if(!same(record,actor,branchId,{...value,customerId,currency})||(input.accountNumber&&record.accountNumber!==v.reference(input.accountNumber,'ACC')))throw v.fail('Creation reference was already used with different details',409);return {record,duplicate:true};};
 const prior=await replay();if(prior)return prior;
 try{return await transaction(conn,async session=>{const current=await fenceAccess(conn,session,tenant,actor,'accounts','accounts.manage');const branch=await fenceBranch(conn,session,branchId);
  const customer=await directory.customerModel(conn).findOneAndUpdate({_id:customerId,branchId,status:'active'},{$inc:{revision:1}},{session,new:true});if(!customer)throw v.fail('Choose an active customer in your operating branch',409);
  branchCurrency.resolve(branch,currency);
  await reserveUsage(current.tenant,'customer_accounts',session);const accountNumber=v.reference(input.accountNumber,'ACC'),accountId=new mongoose.Types.ObjectId();
  const [ledger]=await models.ledgerAccountModel(conn).create([{branchId,currency,code:`CUS_${String(accountId).toUpperCase()}`,name:`Customer account ${accountNumber}`,category:'liability',createdBy:actor.id}],{session});
  const [record]=await Model.create([{_id:accountId,...value,customerId,accountNumber,idempotencyKey:key,branchId,currency,ledgerAccountId:ledger._id,createdBy:actor.id,updatedBy:actor.id}],{session});
  await audit(conn,session,actor,record,'customer.account.created');return {record,duplicate:false};
 });}catch(e){if(e.code===11000){const old=await replay();if(old)return old;throw v.fail('Account number is already in use',409);}throw e;}
}
async function balancesFor(conn,accounts){
 if(!accounts.length)return new Map();const ids=accounts.map(a=>a.ledgerAccountId);
 const rows=await models.ledgerPostingModel(conn).aggregate([{$match:{accountId:{$in:ids}}},{$group:{_id:{account:'$accountId',currency:'$currency',branch:'$branchId'},debit:{$sum:{$cond:[{$eq:['$side','debit']},'$amountMinor',{$toDecimal:'0'}]}},credit:{$sum:{$cond:[{$eq:['$side','credit']},'$amountMinor',{$toDecimal:'0'}]}},postingCount:{$sum:1}}}]);
 const mapping=await models.ledgerAccountModel(conn).find({_id:{$in:ids}}).lean(),byId=new Map(mapping.map(x=>[String(x._id),x])),result=new Map();
 for(const account of accounts){const ledger=byId.get(String(account.ledgerAccountId));if(!ledger||String(ledger.branchId)!==String(account.branchId)||ledger.currency!==account.currency||ledger.category!=='liability'){result.set(String(account._id),{available:false,minor:null,postingCount:0});continue;}
  const row=rows.find(r=>String(r._id.account)===String(ledger._id)&&String(r._id.branch)===String(account.branchId)&&r._id.currency===account.currency);result.set(String(account._id),{available:true,minor:row?String(BigInt(String(row.credit))-BigInt(String(row.debit))):'0',postingCount:row?.postingCount||0});
 }return result;
}
async function accountUpdate(conn,tenant,actor,accountId,input){
 actor=await access(conn,tenant,actor,'accounts','accounts.manage');const value=v.account(input);await prepare(conn);
 return transaction(conn,async session=>{await fenceAccess(conn,session,tenant,actor,'accounts','accounts.manage');const record=await directory.accountModel(conn).findOne({_id:v.id(accountId),...scope(actor),revision:v.revision(input.revision)}).session(session);
  if(!record)throw v.fail('Account was changed or is outside your branch. Reload before editing.',409);
  if(input.customerId&&String(record.customerId)!==String(input.customerId)||input.accountNumber&&record.accountNumber!==input.accountNumber||input.currency&&record.currency!==input.currency)throw v.fail('Account owner, number and currency cannot be changed',409);
  if(record.status==='closed')throw v.fail('Closed accounts cannot be changed',409);
  if(value.status==='closed'){const rows=await models.ledgerPostingModel(conn).find({accountId:record.ledgerAccountId,branchId:record.branchId,currency:record.currency}).session(session).select('side amountMinor').lean();let sum=0n;for(const row of rows)sum+=(row.side==='credit'?1n:-1n)*BigInt(String(row.amountMinor));if(sum!==0n)throw v.fail('An account with a nonzero ledger balance cannot be closed',409);}
  Object.assign(record,value,{updatedBy:actor.id,revision:record.revision+1});await record.save({session});await audit(conn,session,actor,record,'customer.account.updated');return record;
 });
}
async function accountList(conn,tenant,actor,input={}){
 actor=await access(conn,tenant,actor,'accounts','accounts.view');await prepare(conn);const base={...scope(actor)},q=v.text(input.q||'','search',0,100);if(q)base.accountNumber=new RegExp('^'+q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
 const rows=await directory.accountModel(conn).find({$and:[base,v.pageFilter(input.cursor)]}).sort({createdAt:-1,_id:-1}).limit(26).lean(),items=rows.slice(0,25);
 const [customers,balances,total]=await Promise.all([directory.customerModel(conn).find({_id:{$in:items.map(x=>x.customerId)},...scope(actor)}).select('name phone reference status').lean(),balancesFor(conn,items),directory.accountModel(conn).countDocuments(base)]);
 const byId=new Map(customers.map(x=>[String(x._id),x]));items.forEach(x=>{x.customer=byId.get(String(x.customerId));x.balance=balances.get(String(x._id));});return {items,nextCursor:rows.length>25?v.nextCursor(items):null,total,q,actor};
}
async function accountDetail(conn,tenant,actor,accountId){
 actor=await access(conn,tenant,actor,'accounts','accounts.view');await prepare(conn);const record=await directory.accountModel(conn).findOne({_id:v.id(accountId),...scope(actor)}).lean();if(!record)throw v.fail('Account not found in your permitted branch',404);
 record.customer=await directory.customerModel(conn).findById(record.customerId).select('name phone reference status').lean();record.balance=(await balancesFor(conn,[record])).get(String(record._id));return record;
}
async function movements(conn,tenant,actor,input={}){
 actor=await access(conn,tenant,actor,'accounts','accounts.view');await prepare(conn);const match={...queryScope(actor)};if(input.accountId)match._id=oid(v.id(input.accountId));
 const pipeline=[{$match:match},{$lookup:{from:models.ledgerPostingModel(conn).collection.name,let:{ledger:'$ledgerAccountId',branch:'$branchId',currency:'$currency'},pipeline:[{$match:{$expr:{$and:[{$eq:['$accountId','$$ledger']},{$eq:['$branchId','$$branch']},{$eq:['$currency','$$currency']}]}}}],as:'posting'}},{$unwind:'$posting'},{$replaceRoot:{newRoot:{$mergeObjects:['$posting',{accountId:'$_id',accountNumber:'$accountNumber'}]}}}];
 if(input.cursor){const c=v.cursor(input.cursor);pipeline.push({$match:{$or:[{createdAt:{$lt:c.at}},{createdAt:c.at,_id:{$lt:oid(c.id)}}]}});}
 pipeline.push({$sort:{createdAt:-1,_id:-1}},{$limit:26});const rows=await directory.accountModel(conn).aggregate(pipeline),items=rows.slice(0,25),journals=await models.ledgerJournalModel(conn).find({_id:{$in:items.map(x=>x.journalId)},...scope(actor)}).lean(),byId=new Map(journals.map(x=>[String(x._id),x]));
 items.forEach(x=>{x.journal=byId.get(String(x.journalId));x.signedMinor=(x.side==='credit'?'':'-')+String(x.amountMinor);});return {items,nextCursor:rows.length>25?v.nextCursor(items):null,actor,accountId:input.accountId||''};
}
async function logbook(conn,tenant,actor,input={}){
 const trusted=await context(conn,tenant,actor,'customers','customers.view');actor=trusted.actor;tenant=trusted.tenant;await prepare(conn);const customerId=input.customerId?v.id(input.customerId):null;if(customerId)await customerDetail(conn,tenant,actor,customerId);
 const output=[],cursor=v.cursor(input.cursor),cut=cursor?{$or:[{createdAt:{$lt:cursor.at}},{createdAt:cursor.at,_id:{$lt:oid(cursor.id)}}]}:{};
 const definitions=[
  {key:'mobile_money',permission:'mobile_money.view',model:models.mobileTransactionModel,phone:['$customerPhone'],name:['$customer'],path:'/tenant/mobile-money/',amount:'$amountMinor',currency:'$currency',label:'Mobile money',operatorRole:'Mobile Money Operator',operatorField:'operatorId'},
  {key:'money_transfer',permission:'money_transfer.view',model:models.transferOrderModel,phone:['$sender.phone','$beneficiary.phone'],name:['$sender.name','$beneficiary.name'],path:'/tenant/money-transfer/',amount:'$amountMinor',currency:'$currency',label:'Money transfer request',operatorRole:'Money Transfer Operator',operatorField:'createdBy'}
 ];
 for(const source of definitions){if(!hasModuleForUser(tenant,actor,source.key)||!hasPermission(actor,source.permission))continue;const match={...queryScope(actor),...cut};if(actor.role===source.operatorRole)match[source.operatorField]=oid(actor.id);
  const customerMatch={$expr:{$and:[{$eq:['$branchId','$$branch']},{$or:source.phone.map(p=>({$eq:['$phone',`$$phone${source.phone.indexOf(p)}`]}))}]}};if(customerId)customerMatch._id=oid(customerId);
  const letValues={branch:'$branchId'};source.phone.forEach((p,i)=>letValues[`phone${i}`]={$ifNull:[p,'']});
  const rows=await source.model(conn).aggregate([{$match:match},{$lookup:{from:directory.customerModel(conn).collection.name,let:letValues,pipeline:[{$match:customerMatch},{$project:{name:1,reference:1,phone:1}}],as:'customers'}},{$match:{'customers.0':{$exists:true}}},{$sort:{createdAt:-1,_id:-1}},{$limit:26}]);
  output.push(...rows.map(row=>({_id:row._id,createdAt:row.createdAt,label:source.label,reference:row.reference||row.networkReference,status:row.status,amountMinor:row.amountMinor,currency:row.currency,customers:row.customers,href:source.path+row._id,matchBasis:'Recorded phone match'})));
 }
 if(hasModuleForUser(tenant,actor,'accounts')&&hasPermission(actor,'accounts.view')){
  const match={...queryScope(actor)};if(customerId)match.customerId=oid(customerId);
  const rows=await directory.accountModel(conn).aggregate([{$match:match},{$lookup:{from:models.ledgerPostingModel(conn).collection.name,let:{ledger:'$ledgerAccountId',branch:'$branchId',currency:'$currency'},pipeline:[{$match:{$expr:{$and:[{$eq:['$accountId','$$ledger']},{$eq:['$branchId','$$branch']},{$eq:['$currency','$$currency']}]}}}],as:'posting'}},{$unwind:'$posting'},{$lookup:{from:directory.customerModel(conn).collection.name,localField:'customerId',foreignField:'_id',as:'customers'}},{$replaceRoot:{newRoot:{$mergeObjects:['$posting',{directoryAccountId:'$_id',accountNumber:'$accountNumber',customers:'$customers'}]}}},{$match:cut},{$sort:{createdAt:-1,_id:-1}},{$limit:26}]);
  output.push(...rows.map(row=>({_id:row._id,createdAt:row.createdAt,label:row.side==='credit'?'Account credit':'Account debit',reference:row.accountNumber,status:'posted',amountMinor:row.amountMinor,currency:row.currency,customers:row.customers,href:'/tenant/accounts/'+row.directoryAccountId,matchBasis:'Linked customer account / ledger posting'})));
 }
 output.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)||String(b._id).localeCompare(String(a._id)));const items=output.slice(0,25);return {items,nextCursor:output.length>25?v.nextCursor(items):null,actor,customerId};
}
const EXPORT_FIELDS=Object.freeze(['reference','name','phone','email','type','country','city','status','createdAt']);
const MAX_EXPORT_ROWS=10000;
async function customerExport(conn,tenant,actor,input={}){
 actor=await access(conn,tenant,actor,'customers','customers.export');await prepare(conn);
 const Model=directory.customerModel(conn),filter={$and:[scope(actor),search(input.q),...(input.status? [{status:input.status==='archived'?'archived':'active'}]:[])]};
 const count=await Model.countDocuments(filter).maxTimeMS(5000);
 if(count>MAX_EXPORT_ROWS)throw v.fail('Customer export exceeds 10,000 records. Narrow the directory export using the search filter.',422);
 await models.auditEventModel(conn).create({action:'customer.directory.exported',actorId:actor.id,targetId:actor.id,metadata:{branchId:actor.branchId||null,recordCount:count,fields:EXPORT_FIELDS}});
 return Model.find(filter).select(EXPORT_FIELDS.join(' ')).sort({_id:1}).limit(MAX_EXPORT_ROWS).maxTimeMS(10000).lean().cursor({batchSize:100});
}
function formatMinor(amount,currency){if(amount==null)return 'Unavailable';const n=String(amount),negative=n.startsWith('-'),digits=negative?n.slice(1):n,scale=currencyOptions.find(x=>x.code===currency)?.scale||0,padded=digits.padStart(scale+1,'0'),whole=scale?padded.slice(0,-scale):digits,fraction=scale?'.'+padded.slice(-scale):'';return `${currencyLabel(currency)} ${negative?'-':''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')}${fraction}`;}
module.exports={access,scope,customerCreate,customerUpdate,customerArchive,customerList,customerDetail,customerChoices,accountCreate,accountUpdate,accountList,accountDetail,movements,logbook,balancesFor,customerExport,EXPORT_FIELDS,MAX_EXPORT_ROWS,formatMinor,prepare};
