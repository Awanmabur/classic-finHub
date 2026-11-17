'use strict';
const router=require('express').Router();
const requirePermission=require('../../middleware/requirePermission');
const throttle=require('../../platform/services/actionThrottle.service').financial;
const {hasModule}=require('../services/moduleAccess.service');
const preview=require('../settlements/preview');
// Only the existing authenticated tenant router mounts these endpoints.
// Never accept the originating branch or a user-supplied exchange rate.
router.use((req,res,next)=>{
 res.set('Cache-Control','private, no-store').set('X-Robots-Tag','noindex, nofollow');
 if(!hasModule(req.tenant,'mobile_money')&&!hasModule(req.tenant,'forex'))return res.status(403).json({error:'An active financial module is required for currency quotes'});
 if(!req.operationBranch)return res.status(409).json({error:req.operationBranchError||'Assign an operating branch'});
 next();
});
router.post('/mobile-money',requirePermission('mobile_money.view'),throttle,async(req,res,next)=>{
 try{
  const result=await preview.mobileMoney(req.tenantDb,req.tenant,req.user,req.operationBranch,req.body);
  res.json(result.display);
 }catch(error){next(error);}
});
router.post('/transfer-terms',requirePermission('money_transfer.create'),throttle,async(req,res,next)=>{
 try{
  const result=await require('../settlements/preview').transferTerms(
   req.tenantDb,req.tenant,req.user,req.operationBranch,req.body
  );
  res.json(result.display);
 }catch(error){next(error);}
});
router.post('/money-transfer',requirePermission('money_transfer.view'),throttle,async(req,res,next)=>{
 try{
  const result=await preview.transfer(req.tenantDb,req.tenant,req.user,req.operationBranch,req.body);
  res.json(result.display);
 }catch(error){next(error);}
});
module.exports=router;
