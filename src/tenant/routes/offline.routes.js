'use strict';
const router=require('express').Router();
router.get('/offline/context',async(req,res,next)=>{try{
 // Sync needs fresh identity and operating branch, not all dashboard metadata.
 req.operationBranch=null;
 try{req.operationBranch=await require('../services/transactionBranch.service').resolveTransactionBranch(req.tenantDb,req.user);}catch(error){if(![403,409].includes(error.status))throw error;}
 req.viewBranchId=require('../services/branchView.service').canViewBranches(req.user)?req.session.viewBranchId:null;
 res.setHeader('Cache-Control','private, no-store');
 res.json(require('../services/offlineIdentity').context(req));
}catch(error){next(error);}});
module.exports=router;
