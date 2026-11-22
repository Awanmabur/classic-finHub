'use strict';
// Server-only module authorization. Never trust a session's module/branch snapshot
// for writes: refetch and fence persisted actor + tenant inside transactions.
const mongoose=require('mongoose');
const Tenant=require('../../platform/models/Tenant');
const core=require('../models');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const {permissionsFor,requiresTenantMfa}=require('../../config/roles');
const {hasModuleForUser,hasPermission}=require('../services/moduleAccess.service');
const {resolveTransactionBranch}=require('../services/transactionBranch.service');
const treasury=require('../treasury/service');
const crypto=require('node:crypto');
const OID=/^[a-f0-9]{24}$/i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function oid(value,label='record'){if(!OID.test(String(value||'')))throw fail('Invalid '+label,400);return new mongoose.Types.ObjectId(String(value));}
function clean(value,label='field',min=0,max=120){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||/[<>\u0000-\u001f\u007f]/.test(value))throw fail('Invalid '+label);return value.trim();}
function uuid(value){if(!UUID.test(String(value||'')))throw fail('Reload the form to obtain a fresh transaction reference',409);return value.toLowerCase();}
function amount(value,currency){const n=treasury.major(String(value||''),currency);if(n<=0n||n>999999999999999n)throw fail('Choose an amount greater than zero and within the supported range');return n;}
const d=value=>mongoose.Types.Decimal128.fromString(String(value));
function hash(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
async function access(conn,tenant,actor,moduleKey,permission,session=null){
 if(!tenant?.slug||conn?.name!==tenantDbNameFromSlug(tenant.slug)||tenant.dbName!==conn.name)throw fail('Tenant database context mismatch',403);
 const tf={_id:oid(tenant._id,'workspace'),dbName:conn.name,slug:tenant.slug,status:{$in:['active','trial']}};
 const current=session?await Tenant.findOneAndUpdate(tf,{$inc:{__v:1}},{session,new:true}).lean():await Tenant.findOne(tf).lean();
 if(!current)throw fail('Workspace is unavailable',403);
 const uf={_id:oid(actor?.id,'operator'),status:'active'};
 if(session){
   if(actor.authVersion!==undefined&&Number.isSafeInteger(actor.authVersion))uf.authVersion=actor.authVersion===0?{$in:[0,null]}:actor.authVersion;
   if(actor.role)uf.role=actor.role;
 }
 const person=session?await core.tenantUserModel(conn).findOneAndUpdate(uf,{$inc:{__v:1}},{session,new:true}).lean():await core.tenantUserModel(conn).findOne(uf).lean();
 if(!person)throw fail('Staff access changed. Sign in and retry.',403);
 const trusted={id:String(person._id),role:person.role,name:person.name,authVersion:person.authVersion||0,
  branchId:person.branchId||null,transactionBranchId:actor.transactionBranchId||null,
  permissions:permissionsFor(person.role),allowedModules:Array.isArray(person.allowedModules)?person.allowedModules:[]};
 if(!hasModuleForUser(current,trusted,moduleKey)||!hasPermission(trusted,permission))throw fail('Module access or role permission required',403);
 if(require('../../config/mfaPolicy').enabled()&&requiresTenantMfa(person.role)&&!person.mfaEnabledAt)throw fail('Authenticator enrollment required for financial operations',403);
 if(person.role!=='Tenant Owner'&&person.role!=='Auditor'){
   if(!OID.test(String(person.branchId||'')))throw fail('Assigned operating branch required',403);
   const active=await core.branchModel(conn).exists({_id:oid(person.branchId),status:'active'}).session(session);
   if(!active)throw fail('Assigned branch is inactive',403);
 }
 return {actor:trusted,tenant:current};
}
function scope(actor){return ['Tenant Owner','Auditor'].includes(actor.role)?require('../services/branchView.service').readScope(actor):{branchId:oid(actor.branchId,'branch')};}
async function operatingBranch(conn,actor,input={},session=null){
 const branch=await resolveTransactionBranch(conn,actor,input);
 if(session){
  const current=await core.branchModel(conn).findOneAndUpdate({_id:branch._id,status:'active'},{$inc:{revision:1}},{session,new:true}).lean();
  if(!current)throw fail('Operating branch changed',409);
  return current;
 }
 return branch;
}
async function funds(conn,authorization,accountId,branchId,currency,session){
 const a=await treasury.loadAccount(conn,authorization,accountId,{session,fence:true});
 if(String(a.branchId)!==String(branchId)||a.currency!==currency||!['cash','bank','wallet'].includes(a.kind))
  throw fail('Select a real cash, bank or provider wallet in the correct branch and currency',409);
 if(a.status!=='active'||!a.openingApprovedAt||a.openingBalanceMinor===null||a.reconciliationState!=='matched')
  throw fail('The selected funding account requires an approved, matched opening balance',409);
 return a;
}
async function audit(conn,session,actor,targetId,action,metadata={}){
 await core.auditEventModel(conn).create([{action,actorId:oid(actor.id),targetId:oid(targetId),metadata}],{session});
}
async function transact(conn,fn){
 const session=await conn.startSession();
 try{let value;await session.withTransaction(async()=>{value=await fn(session);},{readConcern:{level:'snapshot'}});return value;}
 finally{await session.endSession();}
}
module.exports={fail,oid,clean,uuid,amount,d,hash,access,scope,operatingBranch,funds,audit,transact};
