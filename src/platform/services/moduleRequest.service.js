'use strict';
const mongoose=require('mongoose');
const Request=require('../models/ModuleRequest');
const Audit=require('../models/PlatformAuditLog');
const {eligible}=require('./moduleSubscriptions.service');
function err(message,status=400){const e=new Error(message);e.status=status;return e;}
async function submit(tenant,actor,input){
 if(actor?.role!=='Tenant Owner')throw err('Only the tenant owner can request a module',403);
 if(!['active','trial'].includes(tenant.status))throw err('Tenant must be active to request modules',403);
 const moduleKey=String(input?.moduleKey||''),reason=String(input?.reason||'').trim();
 const module=eligible(moduleKey);
 if(!module||reason.length<20||reason.length>600)throw err('Choose a supported module and an explanation of 20–600 characters');
 const {hasModule}=require('../../tenant/services/moduleAccess.service');
 if(hasModule(tenant,moduleKey))throw err('Module already available to this tenant',409);
 const session=await mongoose.startSession();let requested;
 try{await session.withTransaction(async()=>{
   [requested]=await Request.create([{tenantId:tenant._id,moduleKey,reason,requestedBy:actor.id,
     status:'pending',pricingSnapshot:{currency:'USD',priceMonthlyMinor:Math.round(module.priceMonthly*100)}}],{session});
   await Audit.create([{actorId:String(actor.id),action:'module.requested',moduleKey,recordId:String(tenant._id),
     after:{requestId:String(requested._id),status:'pending',reason}}],{session});
 });return requested;
 }catch(e){if(e.code===11000)throw err('An open request already exists for this module',409);throw e;}finally{await session.endSession();}
}
async function reject(id,actor,input){
 if(!actor?.permissions?.includes('*'))throw err('Super Admin required',403);
 if(!mongoose.isValidObjectId(id))throw err('Request not found',404);
 const reason=String(input?.reason||'').trim();
 if(reason.length<20||reason.length>600)throw err('Provide a 20–600-character rejection explanation');
 const session=await mongoose.startSession();let changed;
 try{await session.withTransaction(async()=>{
   changed=await Request.findOneAndUpdate({_id:id,status:'pending'},{$set:{status:'rejected',reviewedBy:String(actor.id),reviewedAt:new Date(),platformAdminNote:reason}},{session,new:true});
   if(!changed)throw err('Open module request not found',409);
   await Audit.create([{actorId:String(actor.id),action:'module.request_rejected',moduleKey:changed.moduleKey,recordId:String(changed.tenantId),after:{requestId:String(id),reason}}],{session});
 });return changed;}finally{await session.endSession();}
}
module.exports={submit,reject};
