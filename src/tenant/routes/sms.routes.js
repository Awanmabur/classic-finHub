'use strict';
const router=require('express').Router();
const capture=require('../services/smsCapture.service');
const {tenantMenu}=require('../../services/menu.service');
const {consumeFlash,flash,money}=require('../../utils/view');
const requireModule=require('../../middleware/requireModule');
const requirePermission=require('../../middleware/requirePermission');
router.use(requireModule('sms_capture'),requireModule('mobile_money'),requirePermission('mobile_money.cash_in'));
router.use(require('../services/transactionBranch.service').requestContext);
router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
function render(req,res,view,title,data){
  res.render('layouts/dashboard',{context:'tenant',currentPath:'/tenant/sms-capture',pageTitle:title,
    pageSub:'Signed Android SMS capture with manual entry always available.',tenant:req.tenant,user:req.user,
    menu:tenantMenu(req.tenant,req.user),view:`../tenant/sms/${view}`,data,flash:consumeFlash(req),money,
    amountFromMinor:require('../services/mobileMoney.service').fromMinor});
}
router.get('/',async(req,res,next)=>{try{render(req,res,'index','SMS Capture',await capture.getInbox(req.tenantDb,req.tenant,req.user,{cursor:req.query.cursor}));}catch(error){next(error);}});
router.post('/devices',async(req,res,next)=>{try{
  const enrollment=await capture.enroll(req.tenantDb,req.tenant,req.user,req.body);
  render(req,res,'enrolled','Connect Android device',{device:enrollment.device,secret:enrollment.secret});
}catch(error){next(error);}});
router.post('/devices/:deviceId/revoke',async(req,res,next)=>{try{
  await capture.revoke(req.tenantDb,req.tenant,req.user,req.params.deviceId);
  flash(req,'good','Device revoked. It can no longer submit or confirm SMS drafts.');res.redirect(303,'/tenant/sms-capture');
}catch(error){next(error);}});
router.get('/:id',async(req,res,next)=>{try{
  const draft=await capture.getDraft(req.tenantDb,req.tenant,req.user,req.params.id);
  render(req,res,'detail','Review captured SMS',{draft,canConfirm:String(draft.operatorId)===req.user.id});
}catch(error){next(error);}});
router.post('/:id/confirm',require('../../platform/services/actionThrottle.service').financial,async(req,res,next)=>{try{
  await capture.recordDraft(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good','SMS transaction recorded for independent verification.');res.redirect(303,`/tenant/sms-capture/${req.params.id}`);
}catch(error){next(error);}});
router.post('/:id/dismiss',async(req,res,next)=>{try{
  await capture.dismiss(req.tenantDb,req.tenant,req.user,req.params.id,req.body.note);
  flash(req,'good','SMS dismissed and decision audited.');res.redirect(303,`/tenant/sms-capture/${req.params.id}`);
}catch(error){next(error);}});
module.exports=router;
