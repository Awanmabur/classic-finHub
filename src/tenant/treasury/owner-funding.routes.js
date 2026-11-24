'use strict';
const {Router}=require('express');
const requirePermission=require('../../middleware/requirePermission');
const {financial}=require('../../platform/services/actionThrottle.service');
const {flash}=require('../../utils/view');
const {followRecord}=require('../services/branchView.service');
const funding=require('./funding.service');

module.exports=function ownerFundingRoutes(){
 const router=Router();
 router.post('/funding/:id/resolve',requirePermission('treasury.review'),financial,async(req,res,next)=>{
  try{
   const {funding:entry}=await funding.resolveForOwner(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good',entry.status==='posted'?'Funding recorded. The account balances are up to date.':'Pending funding entry discarded.');
   followRecord(req,entry);
   const accountId=req.body.returnToAccount;
   const relatedAccount=accountId&&[entry.sourceAccountId,entry.destinationAccountId].some(id=>String(id)===accountId);
   const target=relatedAccount?'/tenant/treasury?account='+encodeURIComponent(accountId)+'#selected-account':'/tenant/treasury#pending-funding';
   res.redirect(303,target);
  }catch(error){
   if(req.user.role!=='Tenant Owner'||![400,409].includes(error.status))return next(error);
   flash(req,'bad',error.message);
   res.redirect(303,'/tenant/treasury#pending-funding');
  }
 });
 return router;
};
