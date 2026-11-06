'use strict';
const routerFactory=require('express').Router;
const crypto=require('node:crypto');
const requirePermission=require('../../middleware/requirePermission');
const financial=require('../../platform/services/actionThrottle.service').financial;
const fx=require('../services/forex.service');
const branches=require('../services/branch.service');
const {hasPermission}=require('../services/moduleAccess.service');
const {flash}=require('../../utils/view');
module.exports=function routes({renderTenant}){
 const router=routerFactory();
 router.use(require('./operationWorkspace.routes')({renderTenant,moduleKey:'forex'}));
 async function available(req){return (await branches.list(req.tenant)).filter(b=>b.status==='active'&&
  (req.user.role==='Tenant Owner'||String(b._id)===String(req.user.branchId)));}
 router.get('/',requirePermission('forex.view'),async(req,res,next)=>{
  try{
   const branchList=await available(req);
   const selectedId=String(req.operationBranch?._id || '');
   const selected=branchList.find(b=>String(b._id)===selectedId);
   const [rates,records,rateQueue,quoteQueue]=await Promise.all([
    selected?fx.listRates(req.tenantDb,req.tenant,req.user,{status:'active',branchId:selectedId}):[],
    fx.listQuotes(req.tenantDb,req.tenant,req.user),
    fx.reviewer(req.user)&&hasPermission(req.user,'forex.rate_review')?fx.rateReviewQueue(req.tenantDb,req.tenant,req.user):[],
    fx.reviewer(req.user)&&hasPermission(req.user,'forex.quotes.review')?fx.quoteReviewQueue(req.tenantDb,req.tenant,req.user):[]]);
   renderTenant(req,res,'forex/index','Forex Rates & Quotes','Indicative exchange quotations only. No currency exchange, balances or settlement.',{
    branches:branchList,rates,records,rateQueue,quoteQueue,selectedBranchId:selected?selectedId:null,
    canPropose:fx.operator(req.user)&&hasPermission(req.user,'forex.rate_manage'),
    canQuote:fx.operator(req.user)&&hasPermission(req.user,'forex.quotes.create'),
    canRateReview:fx.reviewer(req.user)&&hasPermission(req.user,'forex.rate_review'),
    canQuoteReview:fx.reviewer(req.user)&&hasPermission(req.user,'forex.quotes.review'),
    idempotencyKey:crypto.randomUUID(),amountLabel:fx.amountLabel
   });
  }catch(e){next(e);}
 });
 router.post('/rates',requirePermission('forex.rate_manage'),financial,async(req,res,next)=>{
  try{await fx.proposeRate(req.tenantDb,req.tenant,req.user,req.body);
   flash(req,'good','Indicative rate proposed. A different authorized reviewer must approve it.');res.redirect(303,'/tenant/forex');
  }catch(e){next(e);}
 });
 router.post('/rates/:id/review',requirePermission('forex.rate_review'),financial,async(req,res,next)=>{
  try{await fx.decideRate(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good','Independent rate decision recorded. This is not a verified market price.');res.redirect(303,'/tenant/forex');
  }catch(e){next(e);}
 });
 router.post('/quotes',requirePermission('forex.quotes.create'),financial,async(req,res,next)=>{
  try{const result=await fx.createQuote(req.tenantDb,req.tenant,req.user,req.body);
   flash(req,'good',result.duplicate?'Identical quote returned; no duplicate created.':'Indicative quote saved. No currency has been exchanged.');
   res.redirect(303,`/tenant/forex/${result.quote._id}`);
  }catch(e){next(e);}
 });
 router.get('/history',requirePermission('forex.view'),async(req,res,next)=>{
  try{const records=await fx.listQuotes(req.tenantDb,req.tenant,req.user,{status:req.query.status||null,cursor:req.query.cursor||null});
   renderTenant(req,res,'forex/history','Forex Quote History','Internal quotations and review decisions; not settled currency exchange.',{
    records,status:req.query.status||'',amountLabel:fx.amountLabel
   });
  }catch(e){next(e);}
 });
 router.get('/:id',requirePermission('forex.view'),async(req,res,next)=>{
  try{const quote=await fx.detail(req.tenantDb,req.tenant,req.user,req.params.id);
   renderTenant(req,res,'forex/detail','Forex Quote','Internal quote with fixed approved-rate snapshot; no execution.',{
    quote,amountLabel:fx.amountLabel,
    canReview:quote.status==='quoted'&&new Date(quote.expiresAt)>new Date()&&fx.reviewer(req.user)&&
     hasPermission(req.user,'forex.quotes.review')&&String(quote.createdBy)!==String(req.user.id),
    canCancel:quote.status==='quoted'&&(req.user.role==='Tenant Owner'||String(quote.createdBy)===String(req.user.id))
   });
  }catch(e){next(e);}
 });
 router.post('/:id/review',requirePermission('forex.quotes.review'),financial,async(req,res,next)=>{
  try{await fx.decideQuote(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good','Independent quote decision recorded; no foreign exchange executed.');res.redirect(303,`/tenant/forex/${req.params.id}`);
  }catch(e){next(e);}
 });
 router.post('/:id/cancel',requirePermission('forex.view'),financial,async(req,res,next)=>{
  try{await fx.cancelQuote(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good','Pending quote cancelled and audited.');res.redirect(303,`/tenant/forex/${req.params.id}`);
  }catch(e){next(e);}
 });
 return router;
};
