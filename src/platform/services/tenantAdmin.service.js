'use strict';
const mongoose=require('mongoose');
const Tenant=require('../models/Tenant');
const PlatformAuditLog=require('../models/PlatformAuditLog');
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
const transitions={trial:['active','suspended'],active:['past_due','suspended'],past_due:['active','suspended'],suspended:['active']};
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
function validateDirectoryListing(input){
  const keys=Object.keys(input||{});
  if(keys.some(key=>!['_csrf','action','reason','revision'].includes(key)))throw fail('Invalid public listing request');
  const action=String(input.action||''),reason=String(input.reason||'').trim();
  const revision=String(input.revision??'');
  if(!['publish','hide'].includes(action))throw fail('Choose a valid public listing action');
  if(reason.length<12||reason.length>400)throw fail('Explain the public listing change in 12–400 characters');
  if(!/^(0|[1-9][0-9]{0,9})$/.test(revision))throw fail('Refresh the tenant page to retry',409);
  return {action,reason,revision:Number(revision)};
}
async function changeDirectoryListing(tenantId,actor,input){
  if(!actor?.permissions?.includes('*'))throw fail('Platform administrator required',403);
  if(!/^[a-f0-9]{24}$/i.test(String(tenantId||'')))throw fail('Tenant not found',404);
  if(!/^[a-f0-9]{24}$/i.test(String(actor.id||'')))throw fail('Verified platform administrator required',403);
  const {action,reason,revision}=validateDirectoryListing(input);
  const visibility=action==='publish'?'published':'hidden';
  const session=await mongoose.startSession();let updated;
  try{await session.withTransaction(async()=>{
    const prior=await Tenant.findById(tenantId).session(session);
    if(!prior)throw fail('Tenant not found',404);
    if(prior.__v!==revision)throw fail('Tenant changed; refresh before updating public listing',409);
    if(visibility==='published'&&(!['active','trial'].includes(prior.status)||prior.setupStatus==='invited'))
      throw fail('Only active or trial tenants with completed setup can be listed',409);
    const before=prior.directoryListing?.visibility||'default';
    if(before===visibility)throw fail('Public listing already has this status',409);
    updated=await Tenant.findOneAndUpdate({_id:prior._id,__v:revision},
      {$set:{'directoryListing.visibility':visibility,
        'directoryListing.approvedAt':visibility==='published'?new Date():null,
        'directoryListing.approvedBy':visibility==='published'?new mongoose.Types.ObjectId(actor.id):null},
       $inc:{__v:1}},{new:true,session,runValidators:true});
    if(!updated)throw fail('Tenant changed; refresh before updating public listing',409);
    await PlatformAuditLog.create([{actorId:String(actor.id),actorName:actor.name||'',
      action:'tenant.public_directory_changed',moduleKey:'tenants',recordId:String(tenantId),
      before:{visibility:before},after:{visibility,reason}}],{session});
  });return updated;}finally{await session.endSession();}
}
module.exports={validateStatusChange,changeStatus,validateProfile,updateProfile,validateDirectoryListing,changeDirectoryListing};
