'use strict';
const {Router}=require('express');
const cash=require('../services/cashDrawer.service');
const {hasPermission}=require('../services/moduleAccess.service');
const {flash}=require('../../utils/view');
const throttle=require('../../platform/services/actionThrottle.service').financial;
module.exports=({renderTenant})=>{
 const router=Router();
 const guard=(req,res,next)=>{try{cash.allowed(req.tenant,req.user);next();}catch(error){next(error);}};
 router.get('/cash/shifts',guard,async(req,res,next)=>{
  try{
   const [shifts,branches]=await Promise.all([cash.list(req.tenantDb,req.tenant,req.user,{cursor:req.query.cursor}),require('../services/branch.service').list(req.tenant)]);
   const operators=await require('../models').tenantUserModel(req.tenantDb).find({_id:{$in:shifts.items.map(row=>row.operatorId)}}).select('_id name').lean();
   renderTenant(req,res,'mobile-money/shifts','Cash control review','Opening counts, fund balances and independent physical reconciliation.',{shifts,branches,
    branchNames:Object.fromEntries(branches.map(row=>[String(row._id),row.name])),operatorNames:Object.fromEntries(operators.map(row=>[String(row._id),row.name])),canOpen:cash.opener(req.user),canReview:cash.reviewer(req.user)});
  }catch(error){next(error);}
 });
 router.post('/day/open',guard,throttle,async(req,res,next)=>{try{const shift=await cash.open(req.tenantDb,req.tenant,req.user,req.body);flash(req,'good','Opening count submitted for independent verification.');require('../services/branchView.service').followRecord(req,shift);res.redirect(303,'/tenant/cash/shifts');}catch(error){next(error);}});
 router.get('/cash/shifts/:id',guard,async(req,res,next)=>{try{
  const shift=await cash.detail(req.tenantDb,req.tenant,req.user,req.params.id);
  renderTenant(req,res,'mobile-money/shift-detail','Cash control review','Counted cash and the funds book.',{shift,
   canSubmit:cash.opener(req.user)&&String(shift.operatorId)===String(req.user.id)&&['open','disputed'].includes(shift.status),
   canReview:cash.reviewer(req.user)&&String(shift.operatorId)!==String(req.user.id)&&shift.status==='submitted',
   canReviewOpening:cash.reviewer(req.user)&&String(shift.operatorId)!==String(req.user.id)&&shift.status==='pending_open',
   canApprove:shift.varianceMinor==null||String(shift.varianceMinor)==='0'||req.user.role!=='Branch Manager'});
 }catch(error){next(error);}});
 for(const [action,method,verb] of [['verify-opening','decideOpening','Opening count reviewed.'],['submit','submit','Closing count submitted for independent review.'],['decide','decide','Cash reconciliation decision recorded.']])router.post(`/cash/shifts/:id/${action}`,guard,throttle,async(req,res,next)=>{
  try{const shift=await cash[method](req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good',verb);require('../services/branchView.service').followRecord(req,shift);res.redirect(303,`/tenant/cash/shifts/${req.params.id}`);}catch(error){next(error);}
 });
 return router;
};
