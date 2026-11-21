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

/*
 * Authoritative read-only reconciliation for an ambiguous offline financial
 * submission. The route reveals no customer data, amount or cross-tenant record.
 * A lookup returning "unknown" is NOT permission for automatic retry.
 */
router.get('/offline/operation-status',async(req,res,next)=>{
 try{
  res.set('Cache-Control','private, no-store');
  const reference=req.query.reference,action=req.query.action,requestedBranch=req.query.branchId;
  const operations={
   '/tenant/mobile-money/cash-in':'cash_in',
   '/tenant/mobile-money/cash-out':'cash_out'
  };
  if(typeof reference!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(reference)||
     typeof action!=='string'||!Object.hasOwn(operations,action)||
     typeof requestedBranch!=='string'||!/^[a-f0-9]{24}$/i.test(requestedBranch))
   return res.status(400).json({state:'invalid'});
  const {hasModuleForUser,hasPermission}=require('../services/moduleAccess.service');
  if(!hasModuleForUser(req.tenant,req.user,'mobile_money')||!hasPermission(req.user,'mobile_money.view'))
   return res.status(403).json({state:'denied'});
  const branch=await require('../services/transactionBranch.service').resolveTransactionBranch(req.tenantDb,req.user);
  if(String(branch._id)!==requestedBranch)
   return res.status(409).json({state:'branch_changed'});
  const model=require('../models').mobileTransactionModel(req.tenantDb);
  const record=await model.findOne({idempotencyKey:reference,operatorId:req.user.id,
   branchId:branch._id,operation:operations[action]})
   .select('_id status fundingState').lean().maxTimeMS(3000);
  if(!record)return res.json({state:'unknown'});
  if(record.status!=='recorded'||record.fundingState!=='book_recorded')
   return res.json({state:'review'});
  return res.json({state:'committed',redirect:'/tenant/mobile-money/'+record._id});
 }catch(error){next(error);}
});
module.exports=router;
