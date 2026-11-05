'use strict';
// Shared MongoDB atomically enforces abuse budgets across app replicas.
// Keys contain keyed digests, never raw IP addresses or customer emails.
const crypto = require('crypto');
const LoginThrottle = require('../models/LoginThrottle');
const { sessionSecret } = require('../../config/env');
function throttleKey(category, scope, windowMs, now = Date.now()) {
  const bucket=Math.floor(now/windowMs);
  const hash=crypto.createHmac('sha256',sessionSecret).update(`${category}:${scope}`).digest('hex');
  return `rate:${category}:${bucket}:${hash}`;
}
async function consume({category,scope,limit,windowMs,now=Date.now()}) {
  if (!scope || !Number.isSafeInteger(limit) || limit < 1 || windowMs < 1000) throw new Error('Invalid throttle configuration');
  const _id=throttleKey(category,scope,windowMs,now);
  const expiresAt=new Date((Math.floor(now/windowMs)+2)*windowMs);
  const result=await LoginThrottle.findOneAndUpdate({_id},{$inc:{count:1},$setOnInsert:{expiresAt}},{upsert:true,new:true}).lean();
  if (result.count > limit) {
    const err=new Error('Too many requests. Retry later.'); err.status=429;
    err.retryAfter=Math.ceil(((Math.floor(now/windowMs)+1)*windowMs-now)/1000);
    throw err;
  }
}
async function financial(req,res,next) {
  try {
    if (!req.tenant?.id || !req.user?.id) return res.status(403).send('Forbidden');
    // Both budgets apply; tenants cannot exhaust another tenant's allowance.
    await consume({category:'money-user',scope:`${req.tenant.id}:${req.user.id}`,limit:120,windowMs:60000});
    await consume({category:'money-tenant',scope:req.tenant.id,limit:600,windowMs:60000});
    next();
  } catch(err){if(err.retryAfter)res.setHeader('Retry-After',String(err.retryAfter));next(err);}
}
async function appointment(req,res,next) {
  try {
    await consume({category:'public-appointment',scope:req.ip||'unknown',limit:10,windowMs:3600000});
    next();
  } catch(err){if(err.retryAfter)res.setHeader('Retry-After',String(err.retryAfter));next(err);}
}
// Analytics performs multiple indexed aggregate reads. Bound demand per user
// and per tenant across all replicas to prevent expensive report abuse.
async function analytics(req,res,next) {
  try{
    const tenantId=String(req.tenant?._id||req.tenant?.id||'');
    const userId=String(req.user?.id||'');
    if(!/^[a-f0-9]{24}$/i.test(tenantId)||!/^[a-f0-9]{24}$/i.test(userId))return res.status(403).send('Forbidden');
    await consume({category:'analytics-user',scope:`${tenantId}:${userId}`,limit:20,windowMs:60000});
    await consume({category:'analytics-tenant',scope:tenantId,limit:120,windowMs:60000});
    next();
  }catch(err){if(err.retryAfter)res.setHeader('Retry-After',String(err.retryAfter));next(err);}
}
module.exports={ throttleKey, consume, financial, appointment, analytics };
// Tenant messages have stricter limits than financial-record CRUD, because
// each eligible message can create an external email delivery attempt.
async function notifications(req,res,next){
 try{
  const tenantId=String(req.tenant?._id||req.tenant?.id||''),userId=String(req.user?.id||'');
  if(!/^[a-f0-9]{24}$/i.test(tenantId)||!/^[a-f0-9]{24}$/i.test(userId))return res.status(403).send('Forbidden');
  await consume({category:'notification-user',scope:`${tenantId}:${userId}`,limit:12,windowMs:60000});
  await consume({category:'notification-tenant',scope:tenantId,limit:90,windowMs:60000});
  next();
 }catch(err){if(err.retryAfter)res.setHeader('Retry-After',String(err.retryAfter));next(err);}
}
module.exports.notifications=notifications;
