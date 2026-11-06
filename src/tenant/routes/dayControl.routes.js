'use strict';
const {Router}=require('express');
const {hasModuleForUser,hasPermission}=require('../services/moduleAccess.service');
const {cashSessionModel}=require('../models');
const cash=require('../services/cashDrawer.service');
const mobile=require('../services/mobileMoney.service');
const {flash}=require('../../utils/view');
function fail(message,status=400){return Object.assign(new Error(message),{status});}
module.exports=function dayControlRoutes({renderTenant,recordScope}){
 const router=Router();
 router.get('/transactions/new',require('../../middleware/requirePermission')('dashboard.view'),(req,res)=>
  renderTenant(req,res,'workflow/choose','New transaction','Choose a module, then enter the operation details.',{}));
 router.get('/last-receipt',require('../../middleware/requirePermission')('dashboard.view'),async(req,res,next)=>{
  try{
   const modules=[['mobile_money','mobile_money.view','mobileTransactionModel','mobile-money'],['money_transfer','money_transfer.view','transferOrderModel','money-transfer'],['banking','banking.view','bankingRequestModel','banking'],['forex','forex.view','forexQuoteModel','forex']];
   const choices=await Promise.all(modules.filter(([key,permission])=>hasModuleForUser(req.tenant,req.user,key)&&hasPermission(req.user,permission)).map(async([key,permission,model,route])=>{
    const scope=recordScope(req);
    if(key!=='mobile_money'){delete scope.operatorId;if(['Money Transfer Operator','Banking Operator','Forex Operator'].includes(req.user.role))scope.createdBy=req.user.id;}
    const row=await require('../models')[model](req.tenantDb).findOne(scope).select('_id createdAt').sort({createdAt:-1,_id:-1}).lean();
    return row?{createdAt:row.createdAt,href:`/tenant/${route}/${row._id}${['mobile_money','money_transfer'].includes(key)?'/acknowledgement':''}`}:null;
   }));
   const latest=choices.filter(Boolean).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0];
   res.set('Cache-Control','private, no-store');
   if(latest)return res.redirect(303,latest.href);
   renderTenant(req,res,'workflow/last-receipt','Last receipt','Your latest recorded operation.',{});
  }catch(error){next(error);}
 });
 const guard=[(req,res,next)=>{try{cash.allowed(req.tenant,req.user);next();}catch(error){next(error);}}];
 async function ownShift(req){
  if(!cash.opener(req.user))throw fail('Only the originating operator can close their day',403);
  const branch=await require('../services/transactionBranch.service').resolveTransactionBranch(req.tenantDb,req.user,{});
  return cashSessionModel(req.tenantDb).findOne({operatorId:req.user.id,branchId:branch._id,status:{$in:['open','disputed']}}).lean();
 }
 router.get('/day/close',...guard,async(req,res,next)=>{
  try{const shift=await ownShift(req);renderTenant(req,res,'workflow/close-day','Close day','Auto closing balances from reports.',{shift,
   expected:shift?mobile.formatMoneyMinor(BigInt(String(shift.openingMinor))+BigInt(String(shift.provisionalMovementMinor)),shift.currency):null});
  }catch(error){next(error);}
 });
 router.post('/day/close',...guard,require('../../platform/services/actionThrottle.service').financial,async(req,res,next)=>{
  try{
   const shift=await ownShift(req);
   if(!shift||String(shift._id)!==String(req.body.shiftId))throw fail('Your open cash shift changed. Refresh and try again.',409);
   await cash.submit(req.tenantDb,req.tenant,req.user,shift._id,req.body);
   flash(req,'good','Closing cash submitted for independent reconciliation.');
   res.redirect(303,`/tenant/mobile-money/shifts/${shift._id}`);
  }catch(error){next(error);}
 });
 return router;
};
