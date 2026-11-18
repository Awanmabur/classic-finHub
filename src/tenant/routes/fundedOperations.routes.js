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
   req.session.manualPayoutVerification=await service.checkPayout(req.tenantDb,req.tenant,req.user,req.body);flash(req,'good','PIN and transfer details matched. Verify the receiver before requesting payout.');return res.redirect(303,'/tenant/funded/payout');
  }
  if(req.body.phase!=='request')throw service.fail('Choose Check PIN before requesting payout');
  if(req.body.confirmCashPaid!=='yes'||req.body.confirmRecipientVerified!=='yes')
   throw service.fail('Confirm actual cash handover and recipient identity before submitting the payout');
  const result=await service.requestPayout(req.tenantDb,req.tenant,req.user,req.body);
  delete req.session.manualPayoutVerification;
  if(result.sameBranch){
   const posted=await service.finalizePayout(req.tenantDb,req.tenant,req.user,result.execution._id,req.body);
   flash(req,'good',posted.duplicate?'This PIN payout already posted.':
    'Receiver cash payout is final. Both currency ledgers were updated and audited.');
  }else{
   flash(req,'good','Cross-branch payout recorded for independent interbranch settlement review.');
  }
  require('../services/branchView.service').followRecord(req,result.execution);
  res.redirect(303,`/tenant/funded/${result.execution._id}`);
 }catch(error){if(error.retryAfter)res.set('Retry-After',String(error.retryAfter));next(error);}});
 router.post('/payout/reset',financial,async(req,res,next)=>{try{await service.payoutContext(req.tenantDb,req.tenant,req.user,null);delete req.session.manualPayoutVerification;res.redirect(303,'/tenant/funded/payout');}catch(error){next(error);}});
 router.post('/:id/review',financial,async(req,res,next)=>{try{const result=await service.review(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good',result.execution.status==='posted_manual'?'Manual movement posted to the funds book.':'Manual posting request rejected.');res.redirect(303,`/tenant/funded/${req.params.id}`);}catch(error){next(error);}});
 router.post('/:id/finalize-payout',financial,async(req,res,next)=>{try{
  const result=await service.finalizePayout(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good',result.duplicate?'The same PIN payout was already finalized.':'Verified cash payout finalized and recorded in the correct currency.');
  res.redirect(303,`/tenant/funded/${req.params.id}`);
 }catch(error){next(error);}});
 router.post('/:id/finalize-forex',financial,async(req,res,next)=>{try{
  const result=await service.finalizeForex(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good',result.duplicate?'Forex exchange already posted.':'Forex exchange finalized and posted in both original currencies.');
  res.redirect(303,`/tenant/funded/${req.params.id}`);
 }catch(error){next(error);}});
 router.post('/:id/retry-sms',financial,async(req,res,next)=>{try{await service.retrySms(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good','Receiver SMS queued for provider submission. Check its status before promising delivery.');res.redirect(303,`/tenant/funded/${req.params.id}`);}catch(error){next(error);}});
 router.post('/:id/reveal-pin',financial,async(req,res,next)=>{try{const data=await service.revealPin(req.tenantDb,req.tenant,req.user,req.params.id);renderTenant(req,res,'funded/pin','Transfer payout PIN','Shown once. Share it privately with the sender or receiver.',data);}catch(error){next(error);}});
 router.get('/:id',async(req,res,next)=>{try{const data=await service.detail(req.tenantDb,req.tenant,req.user,req.params.id);renderTenant(req,res,'funded/detail','Manual movement','Source records, independent review and posted book entries.',data);}catch(error){next(error);}});
 router.post('/:sourceType/:sourceId',financial,async(req,res,next)=>{try{
  if(req.params.sourceType==='forex'&&
    (req.body.confirmFundsExchanged!=='yes'||req.body.confirmEvidenceChecked!=='yes'))
    throw service.fail('Confirm both actual Forex custody movements and the checked evidence before submitting');
  const result=await service.request(req.tenantDb,req.tenant,req.user,req.params.sourceType,req.params.sourceId,req.body);
  // Forex is a confirmed physical exchange, not a request for routine approval.
  // Never enable this path for Banking, Money Transfer or unconfirmed custody.
  if(req.params.sourceType==='forex'){
   const posted=await service.finalizeForex(req.tenantDb,req.tenant,req.user,result.execution._id,req.body);
   flash(req,'good',posted.duplicate?'This Forex exchange was already finalized.':'Forex exchange finalized; both currency balances and journals posted.');
  }else flash(req,'good',result.duplicate?'This manual movement request already exists.':'Manual movement recorded for independent review.');
  require('../services/branchView.service').followRecord(req,result.execution);
  res.redirect(303,`/tenant/funded/${result.execution._id}`);
 }catch(error){next(error);}});
 return router;
};
