'use strict';
const requirePermission=require('../../middleware/requirePermission');
const requireModule=require('../../middleware/requireModule');
const throttle=require('../../platform/services/actionThrottle.service').financial;
const {flash}=require('../../utils/view');
const rates=require('../settlements/mobileMoneyRates.service');
module.exports=function routes({renderTenant}){
 const router=require('express').Router();
 router.use(requireModule('mobile_money'),requirePermission('mobile_money.view'));
 router.get('/',async(req,res,next)=>{
  try{
   const branch=req.operationBranch;
   if(!branch)return res.status(409).send(req.operationBranchError||'Assign your operating branch first.');
   const records=await require('../models').forexRateModel(req.tenantDb)
    .find({branchId:branch._id,status:{$in:['pending_review','active']}})
    .sort({createdAt:-1}).limit(80).lean();
   const currencies=(Array.isArray(branch.currencies)&&branch.currencies.length?branch.currencies:[branch.currency])
    .filter(code=>require('../../config/currencies').currencyCodes.includes(code));
   res.set('Cache-Control','private, no-store');
   renderTenant(req,res,'mobile-money/currency-rates','Mobile Money currency rates',
    'Approve actual currency cash prices without subscribing to standalone Forex trading.',{
      branch,records,currencies,canPropose:rates.MAKERS.has(req.user.role),
      canReview:rates.REVIEWERS.has(req.user.role)
    });
  }catch(error){next(error);}
 });
 router.post('/',throttle,async(req,res,next)=>{
  try{
   if(!req.operationBranch)return res.status(409).send('Assign your operating branch first.');
   await rates.propose(req.tenantDb,req.tenant,req.user,req.operationBranch._id,req.body);
   flash(req,'good','Currency rate proposed. An independent authorized reviewer must approve it.');
   res.redirect(303,'/tenant/mobile-money/currency-rates');
  }catch(error){next(error);}
 });
 router.post('/:id/review',throttle,async(req,res,next)=>{
  try{
   if(!req.operationBranch)return res.status(409).send('Assign your operating branch first.');
   await rates.review(req.tenantDb,req.tenant,req.user,req.operationBranch._id,req.params.id,req.body);
   flash(req,'good','Independent currency rate decision recorded.');
   res.redirect(303,'/tenant/mobile-money/currency-rates');
  }catch(error){next(error);}
 });
 return router;
};