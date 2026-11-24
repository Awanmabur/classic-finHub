'use strict';
const {Router}=require('express');
const cash=require('../services/cashDrawer.service');
const {cashSessionModel,tenantUserModel}=require('../models');
const currencyPolicy=require('../services/branchCurrency.service');
const reviewPolicy=require('../services/reviewPolicy');
const {formatMoneyMinor}=require('../services/mobileMoney.service');
const {flash}=require('../../utils/view');
const throttle=require('../../platform/services/actionThrottle.service').financial;
const activeStatuses=['pending_open','open','submitted','disputed'];
const cashDayUrl=currency=>`/tenant/cash/shifts?currency=${encodeURIComponent(currency)}`;
const isOwnShift=(user,shift)=>String(shift.operatorId)===String(user.id);
function canApproveClosing(user,shift){
 return shift.varianceMinor==null||String(shift.varianceMinor)==='0'||(user.role==='Tenant Owner'&&!isOwnShift(user,shift));
}
module.exports=({renderTenant})=>{
 const router=Router();
 const guard=(req,res,next)=>{try{cash.allowed(req.tenant,req.user);next();}catch(error){next(error);}};
 router.get('/cash/shifts',guard,async(req,res,next)=>{
  try{
   const branch=req.operationBranch;
   const currencyOptions=branch?currencyPolicy.options(branch):[];
   const selectedCurrency=currencyOptions.some(option=>option.code===req.query.currency)?req.query.currency:branch?.currency;
   const canOpen=cash.opener(req.user),canReview=cash.reviewer(req.user);
   const Shift=cashSessionModel(req.tenantDb);
   const [shifts,branches,currentShift,reviewRows,openingBook]=await Promise.all([
    cash.list(req.tenantDb,req.tenant,req.user,{cursor:req.query.cursor}),
    require('../services/branch.service').list(req.tenant),
    canOpen&&branch&&currencyPolicy.supports(branch,selectedCurrency)?Shift.findOne({
     ...cash.activeFilter(branch._id,req.user.id,selectedCurrency),status:{$in:activeStatuses}
    }).lean():null,
    canReview?Shift.find({
     ...cash.visibleScope(req.user),
     ...(reviewPolicy.canSelfReviewRoutine(req.user,req.user.branchId)?{}:{operatorId:{$ne:req.user.id}}),
     status:{$in:['pending_open','submitted']}
    }).select('branchId operatorId currency status openingMinor declaredClosingMinor expectedClosingMinor varianceMinor')
     .sort({createdAt:1,_id:1}).limit(40).lean():[],
    canOpen&&branch&&currencyPolicy.supports(branch,selectedCurrency)?require('../treasury/models').models(req.tenantDb).account.findOne({
     tenantId:req.tenant._id,branchId:branch._id,kind:'cash',operatorId:req.user.id,currency:selectedCurrency,
     status:'active',openingApprovedAt:{$ne:null},reconciliationState:'matched'
    }).select('currency name bookBalanceMinor').lean():null
   ]);
   const reviewQueue=reviewRows.map(shift=>({...shift,canApprove:shift.status==='pending_open'||canApproveClosing(req.user,shift)}));
   const operatorIds=[...new Set([...shifts.items,...reviewQueue].map(row=>String(row.operatorId)))];
   const operators=await tenantUserModel(req.tenantDb).find({_id:{$in:operatorIds}}).select('_id name').lean();
   const expected=currentShift&&['open','disputed'].includes(currentShift.status)
    ?formatMoneyMinor(cash.minor(currentShift.openingMinor)+cash.minor(currentShift.provisionalMovementMinor),currentShift.currency):null;
   renderTenant(req,res,'mobile-money/shifts','Cash day','Open or close your drawer and review cash counts.',{
    shifts,currentShift,expected,reviewQueue,openingBook,currencyOptions,selectedCurrency,canOpen,canReview,showHistory:Boolean(req.query.cursor),
    branchNames:Object.fromEntries(branches.map(row=>[String(row._id),row.name])),
    operatorNames:Object.fromEntries(operators.map(row=>[String(row._id),row.name]))
   });
  }catch(error){next(error);}
 });
 router.post('/day/open',guard,throttle,async(req,res,next)=>{try{const shift=await cash.open(req.tenantDb,req.tenant,req.user,req.body);flash(req,'good','Opening count sent for review.');require('../services/branchView.service').followRecord(req,shift);res.redirect(303,cashDayUrl(shift.currency));}catch(error){next(error);}});
 router.get('/cash/shifts/:id',guard,async(req,res,next)=>{try{
  const shift=await cash.detail(req.tenantDb,req.tenant,req.user,req.params.id);
  const own=isOwnShift(req.user,shift);
  const canReview=cash.reviewer(req.user)&&(!own||reviewPolicy.canSelfReviewRoutine(req.user,shift.branchId));
  renderTenant(req,res,'mobile-money/shift-detail','Cash count details','Counted cash and the funds book.',{shift,
   canSubmit:cash.opener(req.user)&&own&&['open','disputed'].includes(shift.status),
   canReview:canReview&&shift.status==='submitted',
   canReviewOpening:canReview&&shift.status==='pending_open',
   canApprove:canApproveClosing(req.user,shift)});
 }catch(error){next(error);}});
 for(const [action,method,verb] of [['verify-opening','decideOpening','Opening count reviewed.'],['submit','submit','Closing count submitted for review.'],['decide','decide','Cash reconciliation decision recorded.']])router.post(`/cash/shifts/:id/${action}`,guard,throttle,async(req,res,next)=>{
  try{const shift=await cash[method](req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good',verb);require('../services/branchView.service').followRecord(req,shift);res.redirect(303,req.body.returnToDay==='1'?cashDayUrl(shift.currency):`/tenant/cash/shifts/${req.params.id}`);}catch(error){next(error);}
 });
 return router;
};
