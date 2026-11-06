'use strict';
const rateLimit = require('express-rate-limit');
const {createHmac}=require('node:crypto');
const {sessionSecret}=require('../config/env');
const {validAuthAge}=require('./authSessionExpiry');
const OID=/^[a-f0-9]{24}$/i;
function sessionScope(req){
 const session=req.session;
 if(!session||!validAuthAge(session.authenticatedAt)||!OID.test(String(session.identityId||'')))return null;
 if(OID.test(String(session.platformId||''))&&validAuthAge(session.mfaVerifiedAt))return `platform:${session.platformId}:${session.identityId}`;
 if(OID.test(String(session.tenantId||''))&&OID.test(String(session.tenantUserId||'')))return `tenant:${session.tenantId}:${session.tenantUserId}:${session.identityId}`;
 return null;
}
function createTrafficLimiter({windowMs=15*60*1000,publicLimit=250,accountLimit=3000}={}){
 const common={windowMs,standardHeaders:'draft-7',legacyHeaders:false,
  skip:req=>req.path==='/health/live'||req.path==='/health/ready'};
 const general=rateLimit({...common,max:publicLimit});
 const account=rateLimit({...common,max:accountLimit,keyGenerator:req=>
  createHmac('sha256',sessionSecret).update(sessionScope(req)||'unbound').digest('hex')});
 // Identity comes only from the server-side session, never a request field or
 // forwarded header. Protected routes still revalidate the live account.
 const traffic=(req,res,next)=>sessionScope(req)?account(req,res,next):general(req,res,next);
 return {general,traffic};
}
const {general,traffic}=createTrafficLimiter();
const login=rateLimit({windowMs:15*60*1000,max:100,standardHeaders:'draft-7',legacyHeaders:false,
 // Failed logins redirect with 303; redirects must still count as attempts.
 skipSuccessfulRequests:false});
module.exports={general,traffic,login,sessionScope,createTrafficLimiter};
