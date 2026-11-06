'use strict';
// Module terms are independent of base-plan terms. Each grant snapshots its
// commercial conditions; a grant is NOT evidence that a customer has paid.
const mongoose=require('mongoose');
const Tenant=require('../models/Tenant');
const PlatformAuditLog=require('../models/PlatformAuditLog');
const {modules}=require('../../data/store');
const RECORD_MODULES=new Set(['mobile_money','money_transfer','banking','forex','customers','accounts','expenses']);
function requiresRecords(key){return RECORD_MODULES.has(key);}
function error(message,status=400){const e=new Error(message);e.status=status;return e;}
function listable(){return modules.filter(m=>m.key!=='sms_capture'&&['enabled','recording_only'].includes(m.runtimeStatus)&&m.status==='active');}
function eligible(key){return listable().find(m=>m.key===key)||null;}
function activeGrants(tenant,now=new Date()){
  if(!tenant||!['active','trial'].includes(tenant.status)||!Array.isArray(tenant.moduleGrants))return [];
  return tenant.moduleGrants.filter(g=>g.status==='granted'&&eligible(g.moduleKey)&&
    Number.isSafeInteger(g.generation)&&g.generation>0&&g.periodStart&&g.periodEnd&&
    new Date(g.periodStart)<=now&&new Date(g.periodEnd)>now&&
    g.limits&&Number.isSafeInteger(g.limits.users)&&g.limits.users>=1&&
    Number.isSafeInteger(g.limits.branches)&&g.limits.branches>=1&&
    Number.isSafeInteger(g.limits.recordsPerMonth)&&g.limits.recordsPerMonth>=0);
}
function effectiveModuleGrant(tenant,key,now=new Date()){return activeGrants(tenant,now).find(g=>g.moduleKey===key)||null;}
function validateGrant(input){
  const moduleKey=String(input?.moduleKey||'');const module=eligible(moduleKey);
  if(!module)throw error('Module is unavailable for independent subscription',409);
  const days=Number(input.days),users=Number(input.users),branches=Number(input.branches),recordsPerMonth=Number(input.recordsPerMonth||0);
  const reason=String(input.reason||'').trim();
  if(!Number.isSafeInteger(days)||days<1||days>366||
    !Number.isSafeInteger(users)||users<1||users>10000||
    !Number.isSafeInteger(branches)||branches<1||branches>1000||
    !Number.isSafeInteger(recordsPerMonth)||recordsPerMonth<0||recordsPerMonth>1000000||
    (requiresRecords(moduleKey)?recordsPerMonth<1:recordsPerMonth!==0)||reason.length<20||reason.length>600)
    throw error('Specify a 1–366 day term, valid workspace limits, and a 20–600-character audit reason');
  return {moduleKey,days,limits:{users,branches,recordsPerMonth},reason,priceMonthlyMinor:Math.round(module.priceMonthly*100)};
}
function requireAdmin(actor){if(!actor?.id||!actor.permissions?.includes('*'))throw error('Super Admin required',403);}
function validTenant(id){if(!mongoose.isValidObjectId(id))throw error('Tenant not found',404);}
async function grantModule(tenantId,actor,input){
  requireAdmin(actor);validTenant(tenantId);
  const values=validateGrant(input),now=new Date();let result;
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    const tenant=await Tenant.findById(tenantId).session(session);
    if(!tenant)throw error('Tenant not found',404);
    if(!['active','trial'].includes(tenant.status))throw error('Activate tenant before granting modules',409);
    const baseLimits=require('./commercial.service').effectiveSubscription(tenant)?.limits||{};
    const other=activeGrants(tenant).filter(g=>g.moduleKey!==values.moduleKey);
    const maxSeats=Math.max(baseLimits.users||0,values.limits.users,...other.map(g=>g.limits.users));
    const maxBranches=Math.max(baseLimits.branches||0,values.limits.branches,...other.map(g=>g.limits.branches));
    if(tenant.seatsReserved>maxSeats)throw error('Existing user seats exceed the proposed combined workspace limit',409);
    if(tenant.branchCount>maxBranches)throw error('Existing branches exceed the proposed combined workspace limit',409);
    const current=(tenant.moduleGrants||[]).find(g=>g.moduleKey===values.moduleKey);
    const extending=current?.status==='granted'&&new Date(current.periodEnd)>now;
    const termEnd=new Date((extending?new Date(current.periodEnd):now).getTime()+values.days*86400000);
    if(termEnd.getTime()-now.getTime()>366*86400000)throw error('Module term may not exceed 366 days from now',409);
    const generation=extending?current.generation:(current?.generation||0)+1;
    const next={moduleKey:values.moduleKey,status:'granted',periodStart:extending?current.periodStart:now,
      periodEnd:termEnd,generation,currency:'USD',priceMonthlyMinor:values.priceMonthlyMinor,limits:values.limits};
    const grants=(tenant.moduleGrants||[]).filter(g=>g.moduleKey!==values.moduleKey).map(g=>g.toObject?g.toObject():g);
    grants.push(next);
    const changed=await Tenant.findOneAndUpdate({_id:tenantId,__v:tenant.__v,
      seatsReserved:{$lte:maxSeats},branchCount:{$lte:maxBranches},status:{$in:['active','trial']}},
      {$set:{moduleGrants:grants},$inc:{__v:1}},{session,new:true,runValidators:true});
    if(!changed)throw error('Workspace capacity or subscription changed concurrently. Refresh and retry.',409);
    await PlatformAuditLog.create([{actorId:String(actor.id),actorName:String(actor.name||''),
      action:extending?'module.renewed':'module.granted',moduleKey:values.moduleKey,recordId:String(tenantId),
      before:current?{status:current.status,periodEnd:current.periodEnd,generation:current.generation}:null,
      after:{status:'granted',periodEnd:termEnd,generation,limits:values.limits,priceMonthlyMinor:values.priceMonthlyMinor,reason:values.reason,chargeCollected:false}}],{session});
    await require('../models/ModuleRequest').updateMany({tenantId:tenant._id,moduleKey:values.moduleKey,status:'pending'},
      {$set:{status:'approved',reviewedBy:String(actor.id),reviewedAt:now,platformAdminNote:values.reason}},{session});
    result=next;
  });return result;}catch(e){if(e.name==='VersionError')throw error('Concurrent module change. Refresh and retry.',409);throw e;}
  finally{await session.endSession();}
}
async function revokeModule(tenantId,actor,input){
  requireAdmin(actor);validTenant(tenantId);
  const key=String(input?.moduleKey||''),reason=String(input?.reason||'').trim();
  if(!eligible(key)||reason.length<20||reason.length>600)throw error('Select a valid module and provide an audit justification');
  const session=await mongoose.startSession();let revoked;
  try{await session.withTransaction(async()=>{
    const tenant=await Tenant.findById(tenantId).session(session);
    if(!tenant)throw error('Tenant not found',404);
    const grant=tenant.moduleGrants?.find(g=>g.moduleKey===key);
    if(!grant||grant.status!=='granted')throw error('No active module grant to revoke',409);
    const before={periodEnd:grant.periodEnd,generation:grant.generation};
    const grants=tenant.moduleGrants.map(g=>{
      const d=g.toObject?g.toObject():{...g};
      if(d.moduleKey===key)d.status='revoked';
      return d;
    });
    const changed=await Tenant.findOneAndUpdate({_id:tenantId,__v:tenant.__v},
      {$set:{moduleGrants:grants},$inc:{__v:1}},{session,new:true,runValidators:true});
    if(!changed)throw error('Module changed concurrently. Refresh and retry.',409);
    // A base-plan module remains available even if its redundant addon is revoked.
    // Otherwise strip stale assignments transactionally so a later renewal cannot
    // silently restore permission to old staff or pending invitations.
    const base=require('./commercial.service').effectiveSubscription(tenant);
    const baseStillIncludes=base?.modules.includes(key)&&tenant.enabledModules?.includes(key);
    if(!baseStillIncludes){
      const conn=require('../../config/mongo').getTenantConnection(tenant.slug);
      const models=require('../../tenant/models');
      await models.tenantUserModel(conn).updateMany({allowedModules:key},
        {$pull:{allowedModules:key},$inc:{authVersion:1}},{session});
      await models.staffInviteModel(conn).updateMany({status:'pending',allowedModules:key},
        {$pull:{allowedModules:key}},{session});
    }
    await PlatformAuditLog.create([{actorId:String(actor.id),actorName:String(actor.name||''),
      action:'module.revoked',moduleKey:key,recordId:String(tenantId),before,
      after:{status:'revoked',reason}}],{session});
    revoked={moduleKey:key,status:'revoked'};
  });return revoked;}catch(e){if(e.name==='VersionError')throw error('Concurrent module change. Refresh and retry.',409);throw e;}
  finally{await session.endSession();}
}
module.exports={requiresRecords,listable,eligible,activeGrants,effectiveModuleGrant,validateGrant,grantModule,revokeModule};
