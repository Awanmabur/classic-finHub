'use strict';
const {Router}=require('express');
const cash=require('../services/cashDrawer.service');
const {cashSessionModel,tenantUserModel}=require('../models');
const currencyPolicy=require('../services/branchCurrency.service');
const reviewPolicy=require('../services/reviewPolicy');
const {formatMoneyMinor}=require('../services/mobileMoney.service');
const {flash}=require('../../utils/view');
const throttle=require('../../platform/services/actionThrottle.service').financial;
const branchView=require('../services/branchView.service');
const activeStatuses=['pending_open','open','submitted','disputed'];
function cashDayUrl(user,currency){
 const query=typeof currency==='string'&&/^[A-Z]{3}$/.test(currency)?`?currency=${currency}`:'';
 return user.role==='Tenant Owner'?'/tenant/treasury'+query+'#cash-day':'/tenant/cash/shifts'+query;
}
function cashDayError(req,res,next,error){
 if(req.user.role!=='Tenant Owner'||![400,409,422].includes(error.status))return next(error);
 flash(req,'bad',error.message);
 res.redirect(303,cashDayUrl(req.user,req.body?.currency));
}
const isOwnShift=(user,shift)=>String(shift.operatorId)===String(user.id);
function canApproveClosing(user,shift){
 return user.role==='Tenant Owner'||shift.varianceMinor==null||String(shift.varianceMinor)==='0';
}
async function openingDrawer(req,branch,currency,owner){
 try{
  const book=await require('../treasury/service').findAccount(req.tenantDb,null,{
   branchId:branch._id,kind:'cash',operatorId:req.user.id,currency
  });
  if(book?.openingApprovedAt&&(owner||book.status==='active'&&book.reconciliationState==='matched'))return {book};
  return {};
 }catch(error){
  if(error.status!==409)throw error;
  return {problem:'Set a default drawer for this currency in the account settings.'};
 }
}
async function cashDayData(req,{currency}={}){
 try{cash.allowed(req.tenant,req.user);}catch(error){if(error.status===403)return null;throw error;}
 const owner=req.user.role==='Tenant Owner';
 const cursor=owner?req.query.cashCursor:req.query.cursor;
 const branch=req.operationBranch;
 const currencyOptions=branch?currencyPolicy.options(branch):[];
 const requestedCurrency=req.query.currency||currency;
 const selectedCurrency=currencyOptions.some(option=>option.code===requestedCurrency)?requestedCurrency:branch?.currency;
 const canOpen=cash.opener(req.user),canReview=cash.reviewer(req.user);
 const showDrawer=canOpen&&branch&&currencyPolicy.supports(branch,selectedCurrency);
 const Shift=cashSessionModel(req.tenantDb);
 const [shifts,branches,currentShift,reviewRows,drawer]=await Promise.all([
  cash.list(req.tenantDb,req.tenant,req.user,{cursor}),
  require('../services/branch.service').list(req.tenant),
  showDrawer?Shift.findOne({
   ...cash.activeFilter(branch._id,req.user.id,selectedCurrency),status:{$in:activeStatuses}
  }).lean():null,
  canReview?Shift.find({
   ...cash.visibleScope(req.user),
   ...(reviewPolicy.canSelfReviewRoutine(req.user,req.user.branchId)?{}:{operatorId:{$ne:req.user.id}}),
   status:{$in:['pending_open','submitted']}
  }).select('branchId operatorId currency status openingMinor declaredClosingMinor expectedClosingMinor varianceMinor')
   .sort({createdAt:1,_id:1}).limit(40).lean():[],
  showDrawer?openingDrawer(req,branch,selectedCurrency,owner):{}
 ]);
 if(owner&&currentShift&&['pending_open','submitted'].includes(currentShift.status)&&
   !reviewRows.some(row=>String(row._id)===String(currentShift._id)))reviewRows.unshift(currentShift);
 const reviewQueue=reviewRows.map(shift=>({...shift,canApprove:shift.status==='pending_open'||canApproveClosing(req.user,shift)}));
 const operatorIds=[...new Set([...shifts.items,...reviewQueue].map(row=>String(row.operatorId)))];
 const operators=await tenantUserModel(req.tenantDb).find({_id:{$in:operatorIds}}).select('_id name').lean();
 const expectedMinor=currentShift&&['open','disputed'].includes(currentShift.status)
  ?String(cash.minor(currentShift.openingMinor)+cash.minor(currentShift.provisionalMovementMinor)):null;
 return {
  shifts,currentShift,expected:expectedMinor===null?null:formatMoneyMinor(expectedMinor,currentShift.currency),expectedMinor,
  reviewQueue,openingBook:drawer.book,openingProblem:drawer.problem,currencyOptions,selectedCurrency,
  canOpen,canReview,showHistory:Boolean(cursor),format:formatMoneyMinor,
  branchNames:Object.fromEntries(branches.map(row=>[String(row._id),row.name])),
  operatorNames:Object.fromEntries(operators.map(row=>[String(row._id),row.name]))
 };
}
module.exports=({renderTenant})=>{
 const router=Router();
 const guard=(req,res,next)=>{try{cash.allowed(req.tenant,req.user);next();}catch(error){next(error);}};
 router.get('/cash/shifts',guard,async(req,res,next)=>{
  try{
   if(req.user.role==='Tenant Owner'){
    const cursor=typeof req.query.cursor==='string'&&req.query.cursor.length<=200?req.query.cursor:null;
    const url=new URL(cashDayUrl(req.user,req.query.currency),'http://localhost');
    if(cursor)url.searchParams.set('cashCursor',cursor);
    return res.redirect(303,url.pathname+url.search+url.hash);
   }
   renderTenant(req,res,'mobile-money/shifts','Cash day','Open or close your drawer and review cash counts.',await cashDayData(req));
  }catch(error){next(error);}
 });
 router.post('/day/open',guard,throttle,async(req,res,next)=>{
  try{
   const shift=await cash.open(req.tenantDb,req.tenant,req.user,req.body,{ownerDirect:true});
   flash(req,'good',shift.status==='open'?'Day open. Your cash drawer is ready for transactions.':'Opening count sent for review.');
   branchView.followRecord(req,shift);
   res.redirect(303,cashDayUrl(req.user,shift.currency));
  }catch(error){cashDayError(req,res,next,error);}
 });
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
  try{
   const shift=await cash[method](req.tenantDb,req.tenant,req.user,req.params.id,req.body,{ownerDirect:true});
   const owner=req.user.role==='Tenant Owner';
   flash(req,'good',owner&&shift.status==='approved'?'Day closed. Cash count reconciled.':owner&&shift.status==='open'?'Day open. Your cash drawer is ready.':verb);
   branchView.followRecord(req,shift);
   res.redirect(303,owner||req.body.returnToDay==='1'?cashDayUrl(req.user,shift.currency):`/tenant/cash/shifts/${req.params.id}`);
  }catch(error){cashDayError(req,res,next,error);}
 });
 return router;
};
module.exports.cashDayData=cashDayData;
module.exports.cashDayUrl=cashDayUrl;
module.exports.cashDayError=cashDayError;
