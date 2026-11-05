'use strict';
const router=require('express').Router();
const {randomUUID}=require('node:crypto');
const requirePermission=require('../../middleware/requirePermission');
const throttle=require('../../platform/services/actionThrottle.service').financial;
const service=require('../services/approvals.service');
const branchService=require('../services/branch.service');
const {flash}=require('../../utils/view');
module.exports=function approvalsRoutes({renderTenant}){
 async function branches(req){return (await branchService.list(req.tenant)).filter(b=>b.status==='active'&&
  (req.user.role==='Tenant Owner'||String(b._id)===String(req.user.branchId)));}
 router.get('/',requirePermission('approvals.view'),async(req,res,next)=>{try{
  const [policies,records,reviewQueue,branchList]=await Promise.all([
   service.policies(req.tenantDb,req.tenant,req.user),
   service.list(req.tenantDb,req.tenant,req.user,{status:req.query.status||'',cursor:req.query.cursor||''}),
   req.user.permissions.includes('*')||req.user.permissions.includes('approvals.decide')?service.queue(req.tenantDb,req.tenant,req.user):[],
   branches(req)]);
  renderTenant(req,res,'approvals/index','Approval Workflows',
   'Standalone internal decisions; never a substitute for financial-module verification.',{
    policies,records,reviewQueue,branches:branchList,canManage:req.user.role==='Tenant Owner',
    canSubmit:req.user.permissions.includes('*')||req.user.permissions.includes('approvals.submit'),
    idempotencyKey:randomUUID(),status:req.query.status||'',roles:service.ROLES,categories:service.CATEGORIES,
    canDecide:request=>service.canDecide(req.user,request)
   });
 }catch(e){next(e);}});
 router.post('/policies',requirePermission('approvals.manage'),throttle,async(req,res,next)=>{try{
  const custom=req.body.customExpiresHours;
  if(custom!==undefined&&custom!=='') {
   if(typeof custom!=='string'||!/^\d{1,3}$/.test(custom))throw service.fail('Enter a valid custom deadline',400);
  }
  const input=custom ? {...req.body,expiresHours:custom}:req.body;
  await service.publish(req.tenantDb,req.tenant,req.user,input);
  flash(req,'good','New policy version published. Existing requests retain their original routing.');res.redirect(303,'/tenant/approvals');
 }catch(e){next(e);}});
 router.post('/policies/:code/retire',requirePermission('approvals.manage'),throttle,async(req,res,next)=>{try{
  await service.retire(req.tenantDb,req.tenant,req.user,req.params.code);
  flash(req,'good','Policy retired. Existing requests retain their original approval steps.');res.redirect(303,'/tenant/approvals');
 }catch(e){next(e);}});
 router.post('/requests',requirePermission('approvals.submit'),throttle,async(req,res,next)=>{try{
  const result=await service.create(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good',result.duplicate?'Existing identical request opened.':'Internal request submitted. No external business action was executed.');
  res.redirect(303,`/tenant/approvals/${result.request._id}`);
 }catch(e){next(e);}});
 router.get('/:id',requirePermission('approvals.view'),async(req,res,next)=>{try{
  const request=await service.detail(req.tenantDb,req.tenant,req.user,req.params.id);
  renderTenant(req,res,'approvals/detail','Approval Request',
   'Internal review history. An approval does not execute a financial or external operation.',{
    request,canDecide:service.canDecide(req.user,request),
    canCancel:request.status==='pending'&&(req.user.role==='Tenant Owner'||String(request.requesterId)===String(req.user.id))
  });
 }catch(e){next(e);}});
 router.post('/:id/decide',requirePermission('approvals.decide'),throttle,async(req,res,next)=>{try{
  await service.decide(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good','Independent approval decision recorded and audited; no external operation executed.');
  res.redirect(303,`/tenant/approvals/${req.params.id}`);
 }catch(e){next(e);}});
 router.post('/:id/cancel',requirePermission('approvals.view'),throttle,async(req,res,next)=>{try{
  await service.cancel(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good','Request cancelled and retained in history.');res.redirect(303,`/tenant/approvals/${req.params.id}`);
 }catch(e){next(e);}});
 return router;
};
