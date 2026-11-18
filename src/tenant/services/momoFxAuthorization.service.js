'use strict';
// Independent one-time review of real provider/regulatory authorization documents.
// This does NOT validate a provider online or initiate any external payment.
const crypto=require('node:crypto');
const {grants,ensure}=require('../schemas/MomoFxSettlement');
const {models:treasury}=require('../treasury/models');
const {branchModel,auditEventModel}=require('../models');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const auth=require('./financialAuthorization.service');
const OID=/^[a-f0-9]{24}$/i;
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function id(value){if(!OID.test(String(value||'')))throw fail('Invalid authorization record or account',400);return String(value);}
function ref(value,label){if(typeof value!=='string'||! /^[A-Za-z0-9][A-Za-z0-9 ./_:#-]{7,199}$/.test(value.trim()))throw fail('Enter a genuine '+label+' document reference (8–200 characters)');return value.trim();}
function expires(value){if(typeof value!=='string'||! /^\d{4}-\d{2}-\d{2}$/.test(value))throw fail('Enter the documented authorization expiry date');
 const date=new Date(value+'T23:59:59.999Z');
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value||date.getTime()<=Date.now()||date.getTime()>Date.now()+10*366*86400000)
  throw fail('Authorization must have a genuine future expiry (up to ten years)');
 return date;
}
async function access(conn,tenant,actor,branch){
 if(!hasModuleForUser(tenant,actor,'forex')||!hasModuleForUser(tenant,actor,'mobile_money')||
  !hasPermission(actor,'treasury.view'))throw fail('Both Forex and Mobile Money module access required',403);
 if(!branch||branch.status!=='active')throw fail('Active branch required',409);
 if(actor.role!=='Tenant Owner'&&String(actor.branchId)!==String(branch._id))throw fail('Other branch authorization is forbidden',403);
}
async function context(conn,tenant,actor,branch){
 await access(conn,tenant,actor,branch);
 const G=grants(conn);const scope={tenantId:tenant._id,branchId:branch._id};
 const items=await G.find(scope).select('-__v').sort({createdAt:-1}).limit(50).lean();
 const canRequest=actor.role==='Tenant Owner'&&hasPermission(actor,'treasury.manage');
 const canReview=['Branch Manager','Reconciliation Officer'].includes(actor.role)&&hasPermission(actor,'treasury.review');
 return {items,canRequest,canReview};
}
async function request(conn,tenant,actor,branch,input){
 await access(conn,tenant,actor,branch);
 if(actor.role!=='Tenant Owner'||!hasPermission(actor,'treasury.manage'))throw fail('Tenant Owner must submit actual authorization references',403);
 if(input?.confirmedDocuments!=='yes')throw fail('Confirm you hold the original current regulatory and provider authorizations');
 const walletId=id(input.walletAccountId),cashId=id(input.cashAccountId);
 if(walletId===cashId)throw fail('Choose separate wallet and cash accounts');
 const providerAuthorizationReference=ref(input.providerAuthorizationReference,'provider agreement');
 const regulatoryAuthorizationReference=ref(input.regulatoryAuthorizationReference,'regulatory licence');
 const expiry=expires(input.expiresAt);
 await ensure(conn);
 const session=await conn.startSession();
 try{return await session.withTransaction(async()=>{
  const a=await auth.fenceAction(conn,session,actor,tenant,'mobile_money','mobile_money.view',{branchId:String(branch._id)});
  if(a.actor.role!=='Tenant Owner'||!hasModuleForUser(a.tenant,a.actor,'forex')||!hasPermission(a.actor,'treasury.manage'))throw fail('Authorization changed',403);
  const active=await branchModel(conn).findOneAndUpdate({_id:branch._id,status:'active'},{$inc:{revision:1}},{session,new:true}).lean();
  if(!active)throw fail('Branch unavailable',409);
  const accounts=await treasury(conn).account.find({_id:{$in:[walletId,cashId]},tenantId:tenant._id,branchId:branch._id,status:'active',
   openingApprovedAt:{$ne:null},reconciliationState:'matched'}).session(session).lean();
  const wallet=accounts.find(x=>String(x._id)===walletId&&x.kind==='wallet'&&x.network);
  const cash=accounts.find(x=>String(x._id)===cashId&&x.kind==='cash');
  if(!wallet||!cash||wallet.currency===cash.currency)throw fail('Choose a reconciled, independently opened wallet and a different-currency cash drawer',409);
  // Tenant Owner configures authorizations for real cashiers as well as the
  // owner. Custody must not silently bridge two different assigned operators.
  if(wallet.operatorId&&cash.operatorId&&String(wallet.operatorId)!==String(cash.operatorId))
   throw fail('Provider wallet and cash drawer belong to different cashiers; verify and correct their assignment',403);
  const scope={tenantId:tenant._id,branchId:branch._id,walletAccountId:wallet._id,cashAccountId:cash._id,
   providerNetwork:wallet.network,permittedCurrencyPair:wallet.currency+'/'+cash.currency};
  const previous=await grants(conn).findOne({...scope,status:{$in:['pending_review','approved']},expiresAt:{$gt:new Date()}}).session(session).lean();
  if(previous)throw fail('This provider/wallet/drawer/pair already has a pending or active authorization',409);
  const [g]=await grants(conn).create([{...scope,status:'pending_review',requestedBy:a.actor.id,
   providerAuthorizationReference,regulatoryAuthorizationReference,approvedBy:null,reviewedAt:null,expiresAt:expiry}],{session});
  await auditEventModel(conn).create([{action:'mobile_money.fx.authorization.requested',actorId:a.actor.id,targetId:g._id,
   metadata:{branchId:String(branch._id),network:wallet.network,pair:g.permittedCurrencyPair}}],{session});
  return g;
 });}finally{await session.endSession();}
}
async function decide(conn,tenant,actor,branch,grantId,input){
 await access(conn,tenant,actor,branch);
 if(!['Branch Manager','Reconciliation Officer'].includes(actor.role)||!hasPermission(actor,'treasury.review'))
  throw fail('A separate branch supervisor or reconciliation officer must verify the authorization',403);
 if(!['approve','reject'].includes(input.decision))throw fail('Choose approve or reject');
 if(input.decision==='approve'&&input.verifiedOriginals!=='yes')throw fail('Independent verification of original current documents is required');
 const note=String(input.note||'').trim();
 if(note.length<20||note.length>500)throw fail('Document verification notes must be 20–500 characters');
 await ensure(conn);
 const session=await conn.startSession();
 try{return await session.withTransaction(async()=>{
  const a=await auth.fenceAction(conn,session,actor,tenant,'mobile_money','mobile_money.view',{branchId:String(branch._id)});
  if(!hasModuleForUser(a.tenant,a.actor,'forex')||!['Branch Manager','Reconciliation Officer'].includes(a.actor.role)||
     !hasPermission(a.actor,'treasury.review'))throw fail('Reviewer authorization changed',403);
  const g=await grants(conn).findOne({_id:id(grantId),tenantId:tenant._id,branchId:branch._id,status:'pending_review',
   requestedBy:{$ne:a.actor.id},expiresAt:{$gt:new Date()}}).session(session).lean();
  if(!g)throw fail('Authorization expired, already reviewed, or belongs to the requester',409);
  const accounts=await treasury(conn).account.find({_id:{$in:[g.walletAccountId,g.cashAccountId]},tenantId:tenant._id,branchId:branch._id,status:'active',
   openingApprovedAt:{$ne:null},reconciliationState:'matched'}).session(session).lean();
  if(accounts.length!==2)throw fail('Authorization accounts need renewed reconciliation',409);
  const updated=await grants(conn).findOneAndUpdate({_id:g._id,status:'pending_review'},{$set:{
   status:input.decision==='approve'?'approved':'rejected',approvedBy:a.actor.id,reviewedAt:new Date(),reviewNote:note,
   verificationNote:input.decision==='approve'?'Original provider and regulatory documents independently checked':'Rejected pending evidence'
  }},{new:true,session}).lean();
  if(!updated)throw fail('Authorization was already decided',409);
  await auditEventModel(conn).create([{action:'mobile_money.fx.authorization.'+updated.status,actorId:a.actor.id,targetId:g._id,
   metadata:{branchId:String(branch._id),network:g.providerNetwork,pair:g.permittedCurrencyPair}}],{session});
  return updated;
 });}finally{await session.endSession();}
}
async function suspend(conn,tenant,actor,branch,grantId,input={}){
 await access(conn,tenant,actor,branch);
 if(!['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(actor.role)||
  !hasPermission(actor,'treasury.review')&&actor.role!=='Tenant Owner')
  throw fail('Only branch financial supervisors may suspend currency authorization',403);
 const note=String(input.note||'').trim();
 if(note.length<12||note.length>500)throw fail('Explain why the grant is being suspended (12–500 characters)');
 await ensure(conn);
 const session=await conn.startSession();
 try{return await session.withTransaction(async()=>{
  const a=await auth.fenceAction(conn,session,actor,tenant,'mobile_money','mobile_money.view',{branchId:String(branch._id)});
  if(!hasModuleForUser(a.tenant,a.actor,'forex')||
   !['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(a.actor.role)||
   !hasPermission(a.actor,'treasury.review')&&a.actor.role!=='Tenant Owner')
   throw fail('Suspension permission changed',403);
  const row=await grants(conn).findOneAndUpdate({
   _id:id(grantId),tenantId:tenant._id,branchId:branch._id,status:'approved'
  },{$set:{status:'suspended',reviewNote:note}},{session,new:true}).lean();
  if(!row)throw fail('Only an active approved currency pair can be suspended',409);
  await auditEventModel(conn).create([{action:'mobile_money.fx.authorization.suspended',actorId:a.actor.id,targetId:row._id,
   metadata:{branchId:String(branch._id),network:row.providerNetwork,pair:row.permittedCurrencyPair}}],{session});
  return row;
 });}finally{await session.endSession();}
}
module.exports={context,request,decide,suspend,fail,ref,expires};