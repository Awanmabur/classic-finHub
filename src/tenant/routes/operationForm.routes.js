'use strict';
const router=require('express').Router();
const forms=require('../services/operationForm.service');
router.get('/operation-form/:kind',async(req,res,next)=>{try{
 const spec=forms.definition(req.params.kind);forms.authorize(req.tenant,req.user,spec);
 await new Promise((resolve,reject)=>require('../services/transactionBranch.service').requestContext(req,res,error=>error?reject(error):resolve()));
 const {data}=await forms.context(req.tenantDb,req.tenant,req.user,req.operationBranch,req.params.kind,req.query,{activeBranches:res.locals.canViewBranches?res.locals.viewBranches:null});
 res.setHeader('Cache-Control','private, no-store');
 res.render('tenant/operation-form',{kind:req.params.kind,spec,data,user:req.user,tenant:req.tenant,
  currentBranch:req.operationBranch,currentBranchId:String(req.operationBranch._id),phoneDefaults:require('../../utils/phoneCountry').defaults(req),offlineIdentity:require('../services/offlineIdentity')(req)});
}catch(error){next(error);}});
module.exports=router;
