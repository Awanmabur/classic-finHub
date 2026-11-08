'use strict';
const router=require('express').Router();
router.get('/offline/context',(req,res)=>{
 const crypto=require('node:crypto'),actor=req.user;
 res.setHeader('Cache-Control','private, no-store');
 const scope=crypto.createHash('sha256').update(`${req.tenant._id}:${actor.id}:${actor.authVersion||0}`).digest('hex');
 res.json({scope,phoneCountry:res.locals.phoneDefaults.country,csrfToken:req.session.csrfToken,branchId:String(req.operationBranch?._id||''),userName:actor.name,tenantName:req.workspaceIdentity?.name||req.tenant.name,expiresAt:Date.now()+7*86400000});
});
module.exports=router;
