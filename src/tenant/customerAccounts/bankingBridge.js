'use strict';
// Internal customer accounts can be selected on a banking instruction. This
// bridge snapshots identity only: it never posts a journal or changes cash.
const Tenant=require('../../platform/models/Tenant');
const models=require('../models');
const directory=require('./models');
const financialAuth=require('../services/financialAuthorization.service');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const {hasPermission,hasModuleForUser,assignableModules}=require('../services/moduleAccess.service');
const {resolveTransactionBranch}=require('../services/transactionBranch.service');
const {currencyCodes}=require('../../config/currencies');
const OID=/^[a-f0-9]{24}$/i;
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function decodeSelection(value){
 if(typeof value!=='string'||value.length>32)throw fail('Choose a valid customer account or masked bank reference');
 const customer=value.startsWith('account:'),raw=customer?value.slice(8):value;
 if(!OID.test(raw))throw fail('Choose a valid customer account or masked bank reference');
 return {type:customer?'customer_account':'bank_reference',id:raw.toLowerCase(),value:(customer?'account:':'')+raw.toLowerCase()};
}
function parseSelection(value){return decodeSelection(value).value;}
function matches(snapshot,value){
 const parsed=decodeSelection(value);
 return !!snapshot&&String(snapshot.referenceId).toLowerCase()===parsed.id&&(snapshot.referenceType||'bank_reference')===parsed.type;
}
async function context(conn,tenant,actor,{session=null,write=false}={}){
 if(!tenant?.slug||conn.name!==tenantDbNameFromSlug(tenant.slug)||!OID.test(String(tenant._id||''))||!OID.test(String(actor?.id||'')))throw fail('Account instruction workspace is invalid',403);
 const tenantQuery=Tenant.findOne({_id:tenant._id,slug:tenant.slug,dbName:conn.name,status:{$in:['active','trial']}});
 const actorQuery=models.tenantUserModel(conn).findOne({_id:actor.id,status:'active'});
 if(session){tenantQuery.session(session);actorQuery.session(session);}
 const currentTenant=await tenantQuery.lean(),person=await actorQuery.lean();
 if(!currentTenant||!person)throw fail('Workspace or staff access has changed',403);
 const trusted=financialAuth.trustedActor(person);
 if(person.allowedModules===undefined)trusted.allowedModules=assignableModules(currentTenant,person.role);
 if(session&&(trusted.role!==actor.role||trusted.authVersion!==(actor.authVersion||0)||String(trusted.branchId||'')!==String(actor.branchId||'')))throw fail('Account instruction assignment changed. Reload before saving.',409);
 if(!hasModuleForUser(currentTenant,trusted,'banking')||!hasPermission(trusted,write?'banking.requests.create':'banking.view'))throw fail('Banking access is required for account instructions',403);
 const canUseAccounts=hasModuleForUser(currentTenant,trusted,'accounts')&&hasPermission(trusted,'accounts.view');
 return {tenant:currentTenant,actor:trusted,canUseAccounts};
}
function customerReference(account,customer){
 return {_id:account._id,referenceType:'customer_account',customerName:customer.name,institutionName:'Internal customer account',last4:account.accountNumber.slice(-4),currency:account.currency};
}
async function choices(conn,tenant,actor,{branchId=null,limit=500}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw fail('Invalid account selection limit');
 const current=await context(conn,tenant,actor);
 if(!current.canUseAccounts)return [];
 const branch=await resolveTransactionBranch(conn,current.actor);
 if(branchId&&String(branch._id)!==String(branchId))throw fail('Account choices follow your operating branch',403);
 await directory.ensureIndexes(conn);
 const rows=await directory.accountModel(conn).aggregate([
  {$match:{branchId:branch._id,currency:branch.currency,status:'active'}},
  {$lookup:{from:directory.customerModel(conn).collection.name,let:{customer:'$customerId',branch:'$branchId'},pipeline:[{$match:{$expr:{$and:[{$eq:['$_id','$$customer']},{$eq:['$branchId','$$branch']},{$eq:['$status','active']}]}}},{$project:{name:1}}],as:'customer'}},
  {$unwind:'$customer'},
  {$lookup:{from:models.ledgerAccountModel(conn).collection.name,let:{ledger:'$ledgerAccountId',branch:'$branchId',currency:'$currency'},pipeline:[{$match:{$expr:{$and:[{$eq:['$_id','$$ledger']},{$eq:['$branchId','$$branch']},{$eq:['$currency','$$currency']},{$eq:['$category','liability']}]}}},{$project:{_id:1}}],as:'ledger'}},
  {$match:{'ledger.0':{$exists:true}}},{$sort:{accountNumber:1,_id:1}},{$limit:limit},
  {$project:{accountNumber:1,currency:1,'customer.name':1}}
 ]).option({maxTimeMS:3000});
 return rows.map(account=>({...customerReference(account,account.customer),_id:`account:${account._id}`}));
}
async function fenceSelection(conn,session,authorization,{selection,branchId,currency}){
 if(!session||!OID.test(String(branchId||''))||!currencyCodes.includes(currency))throw fail('Account instruction transaction context is invalid');
 const parsed=decodeSelection(selection),current=await context(conn,authorization?.tenant,authorization?.actor,{session,write:true});
 // fenceAction has already locked the staff/tenant rows in this transaction.
 // Independently re-read and restrict both identifiers so a future caller cannot
 // accidentally use a stale request-body role or module assignment here.
 const Branch={findOne:query=>models.branchModel(conn).findOne(query).session(session),find:query=>models.branchModel(conn).find(query).session(session)};
 const branch=await resolveTransactionBranch(conn,current.actor,{}, {Branch});
 if(String(branch._id)!==String(branchId)||branch.currency!==currency)throw fail('Account instruction branch or currency has changed',409);
 if(parsed.type==='bank_reference'){
  const reference=await models.bankReferenceModel(conn).findOneAndUpdate({_id:parsed.id,branchId,currency,status:'active'},{$inc:{revision:1}},{session,new:true}).lean();
  if(!reference)throw fail('Select active account references in the same branch and currency',409);
  return {...reference,referenceType:'bank_reference'};
 }
 if(!current.canUseAccounts)throw fail('Customer Accounts module and account-view permission are required',403);
 const account=await directory.accountModel(conn).findOneAndUpdate({_id:parsed.id,branchId,currency,status:'active'},{$inc:{revision:1}},{session,new:true}).lean();
 if(!account)throw fail('Select an active customer account in the same branch and currency',409);
 const customer=await directory.customerModel(conn).findOneAndUpdate({_id:account.customerId,branchId,status:'active'},{$inc:{revision:1}},{session,new:true}).lean();
 if(!customer)throw fail('The account customer is no longer active in this branch',409);
 // A directory account with an invalid ledger mapping must never be offered as
 // an internal customer account, even though this instruction cannot move funds.
 const ledger=await models.ledgerAccountModel(conn).findOne({_id:account.ledgerAccountId,branchId,currency,category:'liability'}).session(session).lean();
 if(!ledger)throw fail('Customer account ledger mapping is unavailable',409);
 return customerReference(account,customer);
}
module.exports={parseSelection,decodeSelection,matches,choices,fenceSelection,fail};
