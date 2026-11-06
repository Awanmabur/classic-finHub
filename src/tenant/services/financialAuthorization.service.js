'use strict';
// Serialize a financial write with subscription, credential and assignment
// changes. Caller permissions are never treated as authority for the write.
const Tenant=require('../../platform/models/Tenant');
const models=require('../models');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const {permissionsFor}=require('../../config/roles');
const {hasPermission,hasModuleForUser}=require('./moduleAccess.service');
const {resolveTransactionBranch}=require('./transactionBranch.service');
const OBJECT_ID=/^[a-f0-9]{24}$/i;
function fail(message,status=403){return Object.assign(new Error(message),{status});}
function id(value){if(!OBJECT_ID.test(String(value||'')))throw fail('Financial authorization context is invalid.');return String(value);}
function trustedActor(account){return {
 id:String(account._id),name:account.name,role:account.role,authVersion:account.authVersion||0,
 permissions:permissionsFor(account.role),branchId:account.branchId||null,
 allowedModules:Array.isArray(account.allowedModules)?account.allowedModules:[]
};}
async function fenceAction(conn,session,operator,tenant,moduleKey,permission,{branchId=null}={}){
 if(!['mobile_money','money_transfer','banking','forex'].includes(moduleKey)||typeof permission!=='string'||!permission.startsWith(moduleKey+'.'))throw fail('Unsupported financial operation.',400);
 if(!tenant?.slug||conn.name!==tenantDbNameFromSlug(tenant.slug))throw fail('Financial workspace context is invalid.');
 const currentTenant=await Tenant.findOneAndUpdate({_id:id(tenant._id),slug:tenant.slug,dbName:conn.name,status:{$in:['active','trial']}},
  {$inc:{__v:1}},{new:true,session}).lean();
 if(!currentTenant||conn.name!==tenantDbNameFromSlug(currentTenant.slug))throw fail('Financial workspace access changed. Refresh and retry.');
 const version=operator?.authVersion===undefined?0:operator.authVersion;
 if(!Number.isSafeInteger(version)||version<0)throw fail('Financial account authorization is invalid.');
 const account=await models.tenantUserModel(conn).findOneAndUpdate({_id:id(operator?.id),status:'active',role:operator?.role,
  authVersion:version===0?{$in:[0,null]}:version},{$inc:{__v:1}},{new:true,session}).lean();
 if(!account)throw fail('Financial account access changed. Refresh and retry.');
 const actor=trustedActor(account);
 if(!hasPermission(actor,permission)||!hasModuleForUser(currentTenant,actor,moduleKey))throw fail('Financial module and operation permission are required.');
 if(actor.role!=='Tenant Owner'&&String(actor.branchId||'')!==String(operator.branchId||''))throw fail('Your branch assignment changed. Refresh before saving.');
 // Resolve from the persisted account in this transaction, including the sole
 // active-branch compatibility rule for old owner accounts. A reassignment must
 // never redirect an already-entered operation to another physical drawer.
 let branch=null;
 if(branchId){
  const Branch={findOne:query=>models.branchModel(conn).findOne(query).session(session),
   find:query=>models.branchModel(conn).find(query).session(session)};
  branch=await resolveTransactionBranch(conn,actor,{}, {Branch});
  if(String(branch._id)!==id(branchId))throw fail('Your operating branch changed. Refresh before recording.');
 }else if(actor.role!=='Tenant Owner'){
  // Review and directory mutations also serialize with branch archival. They
  // use the fixed staff assignment; owners retain tenant-wide review scope.
  branch=await models.branchModel(conn).findOneAndUpdate({_id:id(actor.branchId),status:'active'},{$inc:{revision:1}},{session,new:true}).lean();
  if(!branch)throw fail('Your assigned branch is unavailable.');
 }
 return {tenant:currentTenant,actor,branch};
}
async function authorizeMobileRecording(conn,session,operator,tenant,branchId,operation){
 if(!['cash_in','cash_out'].includes(operation))throw fail('Unsupported financial operation.',400);
 return fenceAction(conn,session,operator,tenant,'mobile_money',`mobile_money.${operation}`,{branchId});
}
module.exports={fenceAction,authorizeMobileRecording,trustedActor,fail};
