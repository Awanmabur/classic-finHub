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
   const currencyPolicy=require('../services/branchCurrency.service'),branch=req.operationBranch;
   // Never derive physical cash from a form. Show only verified, reconciled
   // drawers owned by this operator; the POST re-reads the current ledger.
   const openingBooks=branch&&cash.opener(req.user)?await require('../treasury/models').models(req.tenantDb).account.find({
     tenantId:req.tenant._id,branchId:branch._id,kind:'cash',operatorId:req.user.id,
     currency:{$in:currencyPolicy.supported(branch)},status:'active',
     openingApprovedAt:{$ne:null},reconciliationState:'matched'
   }).select('_id currency name bookBalanceMinor').sort({currency:1}).limit(10).lean():[];
   renderTenant(req,res,'mobile-money/shifts','Cash control review','Opening counts, fund balances and independent physical reconciliation.',{shifts,branches,
    openingBooks,currencyOptions:branch?currencyPolicy.options(branch):[],selectedCurrency:branch?(currencyPolicy.supports(branch,req.query.currency)?req.query.currency:branch.currency):null,
    branchNames:Object.fromEntries(branches.map(row=>[String(row._id),row.name])),operatorNames:Object.fromEntries(operators.map(row=>[String(row._id),row.name])),canOpen:cash.opener(req.user),canReview:cash.reviewer(req.user)});
  }catch(error){next(error);}
 });
 router.post('/day/open',guard,throttle,async(req,res,next)=>{try{
  const routine=req.user.role==='Tenant Owner'&&req.body.openingFromBook==='on';
  const shift=await (routine?cash.startOwnerMatchedShift:cash.open)(
    req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good',routine?'Cash shift started. You can record transactions now.':'Opening count sent for verification.');
  require('../services/branchView.service').followRecord(req,shift);
  res.redirect(303,`/tenant/cash/shifts/${shift._id}`);
 }catch(error){next(error);}});
 router.get('/cash/shifts/:id',guard,async(req,res,next)=>{try{
  const shift=await cash.detail(req.tenantDb,req.tenant,req.user,req.params.id);
  renderTenant(req,res,'mobile-money/shift-detail','Cash control review','Counted cash and the funds book.',{shift,
   canSubmit:cash.opener(req.user)&&String(shift.operatorId)===String(req.user.id)&&['open','disputed'].includes(shift.status),
   canReview:cash.reviewer(req.user)&&shift.status==='submitted'&&(String(shift.operatorId)!==String(req.user.id)||require('../services/reviewPolicy').canSelfReviewRoutine(req.user,shift.branchId)),
   canReviewOpening:cash.reviewer(req.user)&&shift.status==='pending_open'&&(String(shift.operatorId)!==String(req.user.id)||require('../services/reviewPolicy').canSelfReviewRoutine(req.user,shift.branchId)),
   canApprove:shift.varianceMinor==null||String(shift.varianceMinor)==='0'||(req.user.role==='Tenant Owner'&&String(shift.operatorId)!==String(req.user.id))});
 }catch(error){next(error);}});
 for(const [action,method,verb] of [['verify-opening','decideOpening','Opening count reviewed.'],['submit','submit','Closing count submitted for review.'],['decide','decide','Cash reconciliation decision recorded.']])router.post(`/cash/shifts/:id/${action}`,guard,throttle,async(req,res,next)=>{
  try{
   const quickClose=action==='submit'&&req.user.role==='Tenant Owner'&&req.body.closingFromBook==='on';
   const shift=quickClose?
    await cash.finishOwnerMatchedShift(req.tenantDb,req.tenant,req.user,req.params.id,req.body):
    await cash[method](req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good',quickClose?'Cash shift closed. Actual cash matches the recorded balance.':verb);
   require('../services/branchView.service').followRecord(req,shift);
   res.redirect(303,`/tenant/cash/shifts/${req.params.id}`);
  }catch(error){next(error);}
 });
 return router;
};
