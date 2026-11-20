'use strict';
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const Tenant=require('../models/Tenant');
const Review=require('../models/BusinessReview');
const PlatformAuditLog=require('../models/PlatformAuditLog');
const {sessionSecret}=require('../../config/env');
const directory=require('./businessDirectory.service');
function error(message,status=400){const e=new Error(message);e.status=status;return e;}
function digest(value){return crypto.createHmac('sha256',sessionSecret).update(String(value)).digest('hex');}
function cookieName(slug){return 'cfhr_'+digest('cookie:'+slug).slice(0,16);}
function cookieToken(req,slug){
 const name=cookieName(slug)+'=';
 const pair=String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name));
 const raw=pair?.slice(name.length)||'';
 return /^[0-9a-f]{64}$/.test(raw)?raw:'';
}
function cookieOptions(slug){return {path:'/t/'+slug,httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:90*24*3600*1000};}
function text(v,min,max,label){
 if(typeof v!=='string')throw error('Enter valid '+label+'.');
 const value=v.trim();
 if(value.length<min||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw error(label+' must contain '+min+'–'+max+' readable characters.');
 return value;
}
function reviewFields(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw error('Invalid review form.');
 const allowed=new Set(['_csrf','authorName','rating','comment','website']);
 if(Object.keys(body).some(k=>!allowed.has(k)))throw error('Unexpected review field.');
 if(body.website)throw error('Review could not be accepted.');
 const rating=Number(body.rating);
 if(!Number.isSafeInteger(rating)||rating<1||rating>5)throw error('Choose a rating from one to five stars.');
 return {authorName:text(body.authorName,2,80,'Name'),comment:text(body.comment,15,1600,'Review'),rating};
}
async function eligibleTenant(slug){
 if(!mongoose.connection.readyState||mongoose.connection.readyState!==1)throw error('Reviews are temporarily unavailable.',503);
 const tenant=await Tenant.findOne({slug,...directory.listingFilter()}).select('_id slug name status').lean();
 if(!tenant)throw error('Business is not publicly listed.',404);
 return tenant;
}
async function submit(slug,body,ip){
 const tenant=await eligibleTenant(slug),fields=reviewFields(body);
 const net=digest('review-net:'+slug+':'+String(ip||'unknown'));
 const prior=await Review.countDocuments({tenantId:tenant._id,networkHash:net,
   createdAt:{$gte:new Date(Date.now()-24*3600*1000)}}).maxTimeMS(3000);
 if(prior>=3)throw error('Review limit reached for this connection. Try again tomorrow.',429);
 const token=crypto.randomBytes(32).toString('hex');
 await Review.create({...fields,tenantId:tenant._id,tenantSlug:tenant.slug,
   status:'pending',tokenHash:digest('review-edit:'+token),networkHash:net});
 return {token,cookieName:cookieName(slug),cookieOptions:cookieOptions(slug)};
}
async function publicReviews(tenantId){
 const [rows,summary]=await Promise.all([
  Review.find({tenantId,status:'approved'}).sort({approvedAt:-1,_id:-1})
   .limit(30).select('authorName rating comment ownerReply ownerReplyAt approvedAt').lean().maxTimeMS(2500),
  Review.aggregate([{$match:{tenantId:new mongoose.Types.ObjectId(String(tenantId)),status:'approved'}},
   {$group:{_id:null,count:{$sum:1},avg:{$avg:'$rating'}}}]).option({maxTimeMS:2500})
 ]);
 return {rows,summary:{count:summary[0]?.count||0,avg:summary[0]?Number(summary[0].avg.toFixed(1)):0}};
}
async function myReview(slug,req){
 const token=cookieToken(req,slug);if(!token)return null;
 return Review.findOne({tenantSlug:slug,tokenHash:digest('review-edit:'+token)})
   .select('authorName rating comment status revision createdAt').lean();
}
async function changeMine(slug,req,body,action){
 const token=cookieToken(req,slug);if(!token)throw error('This browser has no review editing access.',403);
 const original=await Review.findOne({tenantSlug:slug,tokenHash:digest('review-edit:'+token)});
 if(!original)throw error('Review editing access has expired.',403);
 if(original.status==='withdrawn')throw error('Withdrawn reviews cannot be restored.',409);
 const revision=String(body?.revision||'');
 if(!/^(0|[1-9]\d{0,8})$/.test(revision)||Number(revision)!==original.revision)throw error('Review changed. Reload and try again.',409);
 const changes=action==='withdraw'?{status:'withdrawn',comment:original.comment}:
   {...reviewFields(body),status:'pending',approvedAt:null,moderatedAt:null,moderatedBy:null,moderationReason:'',ownerReply:'',ownerReplyAt:null};
 const result=await Review.updateOne({_id:original._id,revision:original.revision,status:{$ne:'withdrawn'}},{$set:changes,$inc:{revision:1}});
 if(result.modifiedCount!==1)throw error('Review changed. Reload and try again.',409);
}
async function pending(limit=80){
 return Review.find({status:{$in:['pending','approved','rejected']}}).sort({createdAt:-1,_id:-1})
   .limit(Math.min(limit,100)).select('tenantSlug authorName rating comment status revision createdAt ownerReply').lean();
}
async function moderate(id,actor,body){
 if(!actor?.permissions?.includes('*')||!mongoose.isValidObjectId(actor.id))throw error('Platform administrator required.',403);
 if(!mongoose.isValidObjectId(id))throw error('Review not found.',404);
 if(Object.keys(body||{}).some(k=>!['_csrf','action','revision','reason'].includes(k)))throw error('Invalid moderation fields.');
 const action=body.action;
 if(!['approve','reject'].includes(action))throw error('Choose approve or reject.');
 const revision=Number(body.revision);
 if(!Number.isSafeInteger(revision)||revision<0)throw error('Refresh review list before moderation.',409);
 const reason=text(body.reason,12,400,'Moderation reason');
 const session=await mongoose.startSession();
 try{await session.withTransaction(async()=>{
   const status=action==='approve'?'approved':'rejected';
   const current=await Review.findOne({_id:id,revision,status:'pending'}).session(session).lean();
   if(!current)throw error('Review already changed or moderated.',409);
   const updated=await Review.updateOne({_id:id,revision,status:'pending'},{
     $set:{status,moderatedBy:new mongoose.Types.ObjectId(actor.id),moderatedAt:new Date(),
       moderationReason:reason,...(status==='approved'?{approvedAt:new Date()}:{approvedAt:null})},$inc:{revision:1}},{session});
   if(updated.modifiedCount!==1)throw error('Review changed. Reload moderation list.',409);
   await PlatformAuditLog.create([{actorId:String(actor.id),actorName:String(actor.name||''),
     action:'business.review.moderated',moduleKey:'business_reviews',recordId:String(id),
     before:{status:current.status},after:{status,reason,tenantSlug:current.tenantSlug}}],{session});
 });}finally{await session.endSession();}
}
async function tenantReviews(conn,tenant,actor){
 await require('../../tenant/workspace/service').access(conn,tenant,actor);
 return Review.find({tenantId:tenant._id,status:{$in:['approved','pending','rejected']}})
   .sort({createdAt:-1,_id:-1}).limit(80).select('authorName rating comment status ownerReply revision createdAt').lean();
}
async function reply(conn,tenant,actor,id,body){
 await require('../../tenant/workspace/service').access(conn,tenant,actor,{manage:true});
 if(!mongoose.isValidObjectId(id))throw error('Review not found.',404);
 if(Object.keys(body||{}).some(k=>!['_csrf','reply','revision'].includes(k)))throw error('Invalid reply.');
 const revision=Number(body.revision);
 if(!Number.isSafeInteger(revision)||revision<0)throw error('Refresh reviews and try again.',409);
 const message=typeof body.reply==='string'&&body.reply.trim()?text(body.reply,2,1200,'Business reply'):'';
 const session=await mongoose.startSession();
 try{await session.withTransaction(async()=>{
   const current=await Review.findOne({_id:id,tenantId:tenant._id,status:'approved',revision}).session(session).lean();
   if(!current)throw error('This review changed or is not available for a business response.',409);
   const result=await Review.updateOne({_id:id,tenantId:tenant._id,status:'approved',revision},
     {$set:{ownerReply:message,ownerReplyAt:message?new Date():null},$inc:{revision:1}},{session});
   if(result.modifiedCount!==1)throw error('Review changed. Reload and retry.',409);
   await PlatformAuditLog.create([{actorId:String(actor.id),actorName:String(actor.name||''),
     action:'business.review.reply_updated',moduleKey:'business_reviews',recordId:String(id),
     before:{hasReply:Boolean(current.ownerReply)},after:{hasReply:Boolean(message),tenantSlug:tenant.slug}}],{session});
 });}finally{await session.endSession();}
}
module.exports={cookieName,cookieOptions,cookieToken,reviewFields,eligibleTenant,submit,publicReviews,myReview,changeMine,pending,moderate,tenantReviews,reply};
