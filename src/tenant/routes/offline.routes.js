'use strict';
const router=require('express').Router();
router.get('/offline/context',(req,res)=>{
 const actor=req.user;
 res.setHeader('Cache-Control','private, no-store');
 res.json({...require('../services/offlineIdentity')(req),phoneCountry:res.locals.phoneDefaults.country,csrfToken:req.session.csrfToken,userName:actor.name,tenantName:req.workspaceIdentity?.name||req.tenant.name,expiresAt:Date.now()+7*86400000});
});
module.exports=router;
