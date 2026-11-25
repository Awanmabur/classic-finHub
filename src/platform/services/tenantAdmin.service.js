'use strict';
const mongoose=require('mongoose');
const Tenant=require('../models/Tenant');
const PlatformAuditLog=require('../models/PlatformAuditLog');
const commercial=require('./commercial.service');
const moduleSubscriptions=require('./moduleSubscriptions.service');
const {modules}=require('../../data/store');
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
const transitions={trial:['active','suspended'],active:['past_due','suspended'],past_due:['active','suspended'],suspended:['active']};
const availableModuleKeys=new Set(modules.filter(module=>module.runtimeStatus!=='disabled').map(module=>module.key));
async function listTenants({q='',before=''}={}){
 if(typeof q!=='string'||q.length>80)throw fail('Use a workspace search of up to 80 characters');
 if(typeof before!=='string'||(before&&!/^[a-f0-9]{24}$/i.test(before)))throw fail('Invalid workspace page cursor');
 const search=q.trim();
 const query=before?{_id:{$lt:before}}:{};
 if(search){
  const pattern=new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
  query.$or=['name','slug','owner','email'].map(field=>({[field]:pattern}));
 }
 const rows=await Tenant.find(query).sort({_id:-1}).limit(101).maxTimeMS(5000)
  .select('name slug owner email plan status setupStatus enabledModules subscription moduleGrants').lean();
 const tenants=rows.slice(0,100).map(tenant=>{
  const plan=commercial.effectiveSubscription(tenant);
  const grants=moduleSubscriptions.activeGrants(tenant).filter(grant=>availableModuleKeys.has(grant.moduleKey));
  const assigned=Array.isArray(tenant.enabledModules)?tenant.enabledModules:[];
  const currentModules=new Set([...(plan?.modules||[]).filter(key=>availableModuleKeys.has(key)&&assigned.includes(key)),...grants.map(grant=>grant.moduleKey)]);
  return {...tenant,id:String(tenant._id),currentPlanName:tenant.subscription?.planName||null,
   currentPlanVersion:tenant.subscription?.planVersion||null,planAccessActive:Boolean(plan),
   currentModuleCount:currentModules.size,independentModuleCount:grants.length};
 });
 return {tenants,q:search,before,nextBefore:rows.length>100?tenants.at(-1).id:null};
}
function validateStatusChange(input){
 const status=String(input.status||'');const reason=String(input.reason||'').trim();
 if(!Object.prototype.hasOwnProperty.call(transitions,status)&&!['active','trial'].includes(status))throw fail('Invalid tenant status');
 if(reason.length<12||reason.length>400)throw fail('Provide an audited explanation of 12–400 characters');
 return {status,reason};
}
async function changeStatus(tenantId,actor,input){
 if(!actor?.permissions?.includes('*'))throw fail('Platform administrator required',403);
 if(!/^[a-f0-9]{24}$/i.test(String(tenantId||'')))throw fail('Tenant not found',404);
 const {status,reason}=validateStatusChange(input);
 const session=await mongoose.startSession();let updated;
 try{await session.withTransaction(async()=>{
   const prior=await Tenant.findById(tenantId).session(session);
   if(!prior)throw fail('Tenant not found',404);
   if(!(transitions[prior.status]||[]).includes(status))throw fail('Status transition is not permitted',409);
   updated=await Tenant.findOneAndUpdate({_id:tenantId,status:prior.status},{$set:{status}},{new:true,session});
   if(!updated)throw fail('Tenant changed concurrently; retry',409);
   await PlatformAuditLog.create([{actorId:String(actor.id),actorName:actor.name||'',action:'tenant.status_changed',moduleKey:'tenants',recordId:String(tenantId),before:{status:prior.status},after:{status,reason}}],{session});
 });return updated;}finally{await session.endSession();}
}

function validateProfile(input){
 const name=String(input.name||'').trim();const phone=String(input.phone||'').trim();const reason=String(input.reason||'').trim();
 if(name.length<2||name.length>150||phone.length>40||!/^[+0-9 ()-]*$/.test(phone))throw fail('Enter a valid tenant display name and phone');
 if(reason.length<12||reason.length>400)throw fail('Explain the profile change in 12–400 characters');
 return {name,phone,reason};
}
async function updateProfile(tenantId,actor,input){
 if(!actor?.permissions?.includes('*'))throw fail('Platform administrator required',403);
 if(!/^[a-f0-9]{24}$/i.test(String(tenantId||'')))throw fail('Tenant not found',404);
 const {name,phone,reason}=validateProfile(input);
 const session=await mongoose.startSession();let updated;
 try{await session.withTransaction(async()=>{
   const prior=await Tenant.findById(tenantId).session(session);
   if(!prior)throw fail('Tenant not found',404);
   updated=await Tenant.findOneAndUpdate({_id:tenantId,updatedAt:prior.updatedAt},{$set:{name,phone}},{session,new:true});
   if(!updated)throw fail('Concurrent tenant edit; refresh and retry',409);
   await PlatformAuditLog.create([{actorId:String(actor.id),actorName:actor.name||'',action:'tenant.profile_updated',moduleKey:'tenants',recordId:String(tenantId),before:{name:prior.name,phone:prior.phone},after:{name,phone,reason}}],{session});
 });return updated;}finally{await session.endSession();}
}
module.exports={listTenants,validateStatusChange,changeStatus,validateProfile,updateProfile};
