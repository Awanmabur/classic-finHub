'use strict';
const {Router}=require('express');
const service=require('../services/fundedOperations.service');
const financial=require('../../platform/services/actionThrottle.service').financial;
const {flash}=require('../../utils/view');
module.exports=function fundedOperationsRoutes({renderTenant}){
 const router=Router();
 router.use((req,res,next)=>{res.set({'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow'});next();});
 router.get('/',async(req,res,next)=>{try{const data=await service.list(req.tenantDb,req.tenant,req.user,req.query);renderTenant(req,res,'funded/index','Manual financial movements','Reviewed balances and posted manual books.',data);}catch(error){next(error);}});
 router.get('/context',async(req,res,next)=>{try{const data=await service.prepare(req.tenantDb,req.tenant,req.user,req.query.sourceType,req.query.sourceId);res.json(data);}catch(error){next(error);}});
 router.get('/prepare/:sourceType/:sourceId',async(req,res,next)=>{try{const data=await service.prepare(req.tenantDb,req.tenant,req.user,req.params.sourceType,req.params.sourceId);renderTenant(req,res,'funded/prepare','Record manual movement','Use the actual counted cash, wallet or statement balance.',data);}catch(error){next(error);}});
 router.get('/payout',async(req,res,next)=>{try{const data=await service.payoutContext(req.tenantDb,req.tenant,req.user,req.session.manualPayoutVerification);renderTenant(req,res,'funded/payout','Payout by PIN','Verify the receiver and request an independently reviewed cash payout.',data);}catch(error){next(error);}});
 router.post('/payout',financial,async(req,res,next)=>{try{
  if(req.body.phase==='check'){
   req.session.manualPayoutVerification=await service.checkPayout(req.tenantDb,req.tenant,req.user,req.body);flash(req,'good','PIN and receiver matched. Review the details before requesting payout.');return res.redirect(303,'/tenant/funded/payout');
  }
  if(req.body.phase!=='request')throw service.fail('Choose Check PIN before requesting payout');
  const result=await service.requestPayout(req.tenantDb,req.tenant,req.user,req.body);delete req.session.manualPayoutVerification;
  flash(req,'good',result.duplicate?'This payout request already exists.':'Payout requested for independent review.');res.redirect(303,`/tenant/funded/${result.execution._id}`);
 }catch(error){if(error.retryAfter)res.set('Retry-After',String(error.retryAfter));next(error);}});
 router.post('/payout/reset',financial,async(req,res,next)=>{try{await service.payoutContext(req.tenantDb,req.tenant,req.user,null);delete req.session.manualPayoutVerification;res.redirect(303,'/tenant/funded/payout');}catch(error){next(error);}});
 router.post('/:id/review',financial,async(req,res,next)=>{try{const result=await service.review(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good',result.execution.status==='posted_manual'?'Manual movement posted to the funds book.':'Manual posting request rejected.');res.redirect(303,`/tenant/funded/${req.params.id}`);}catch(error){next(error);}});
 router.post('/:id/reveal-pin',financial,async(req,res,next)=>{try{const data=await service.revealPin(req.tenantDb,req.tenant,req.user,req.params.id);renderTenant(req,res,'funded/pin','Transfer payout PIN','Shown once. Share it privately with the sender or receiver.',data);}catch(error){next(error);}});
 router.get('/:id',async(req,res,next)=>{try{const data=await service.detail(req.tenantDb,req.tenant,req.user,req.params.id);renderTenant(req,res,'funded/detail','Manual movement','Source records, independent review and posted book entries.',data);}catch(error){next(error);}});
 router.post('/:sourceType/:sourceId',financial,async(req,res,next)=>{try{const result=await service.request(req.tenantDb,req.tenant,req.user,req.params.sourceType,req.params.sourceId,req.body);flash(req,'good',result.duplicate?'This manual movement request already exists.':'Manual movement recorded for independent review.');res.redirect(303,`/tenant/funded/${result.execution._id}`);}catch(error){next(error);}});
 return router;
};
