'use strict';
const express=require('express');
const crypto=require('node:crypto');
const {flash}=require('../../utils/view');
const requireModule=require('../../middleware/requireModule');
const requirePermission=require('../../middleware/requirePermission');
const {hasPermission}=require('../services/moduleAccess.service');
const {customerModel}=require('../customerAccounts/models');
const treasury=require('../treasury/service');
const loans=require('./loans.service');
const airtime=require('./airtime.service');
const {currencyCodes}=require('../../config/currencies');
const {resolve:branchCurrency}=require('../services/branchCurrency.service');
const throttle=require('../../platform/services/actionThrottle.service').financial;
function fundsFor(req,key){
 if(!req.operationBranch||!hasPermission(req.user,'treasury.view'))return Promise.resolve([]);
 return treasury.findOperatingAccounts(req.tenantDb,req.tenant,req.user,{moduleKey:key,branchId:String(req.operationBranch._id)})
 .then(items=>items.filter(a=>a.status==='active'&&a.openingBalanceMinor!==null&&a.openingApprovedAt&&a.reconciliationState==='matched'&&['cash','bank','wallet'].includes(a.kind)));
}
function localDate(req,value){
 if(!value)return '—';
 return require('../../utils/businessTime').localDay(value,require('../../utils/businessTime').forBranch(req.viewBranch||req.operationBranch));
}
function shortFormat(value,currency){
 return require('../services/mobileMoney.service').formatMoneyMinor(value,currency);
}
module.exports=function retailRoutes({renderTenant}){
 const router=express.Router();
 router.use('/loans',requireModule('loans'),requirePermission('loans.view'));
 router.use('/airtime',requireModule('airtime'),requirePermission('airtime.view'));
 async function loanPage(req,res,next){
  try{
   const [result,funds,customers]=await Promise.all([
    loans.list(req.tenantDb,req.tenant,req.user),fundsFor(req,'loans'),
    req.operationBranch?customerModel(req.tenantDb).find({branchId:req.operationBranch._id,status:'active'})
      .select('_id reference name').sort({name:1}).limit(250).lean():Promise.resolve([])
   ]);
   renderTenant(req,res,'loans/index','Loan Management','Borrower applications, independent review, funded disbursement and repayments.',{
    ...result,funds,customers,canManage:hasPermission(req.user,'loans.manage'),
    canCreate:hasPermission(req.user,'loans.create'),format:shortFormat,uuid:crypto.randomUUID(),
    branch:req.operationBranch,activeCurrency:req.operationBranch?branchCurrency(req.operationBranch):null,
    currencyChoices:req.operationBranch?require('../services/branchCurrency.service').supported(req.operationBranch):[],
    formatDate:value=>localDate(req,value)
   });
  }catch(error){next(error);}
 }
 router.get('/loans',loanPage);
 router.post('/loans/products',requirePermission('loans.manage'),throttle,async(req,res,next)=>{try{
  await loans.createProduct(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good','Loan product saved with immutable terms and an audit record.');
  res.redirect(303,'/tenant/loans');
 }catch(e){next(e);}});
 router.post('/loans/applications',requirePermission('loans.create'),throttle,async(req,res,next)=>{try{
  const {loan,duplicate}=await loans.apply(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good',duplicate?'Loan application already recorded. No duplicate created.':'Loan application submitted for independent review. No funds have been disbursed.');
  res.redirect(303,'/tenant/loans/'+loan._id);
 }catch(e){next(e);}});
 router.get('/loans/:id',async(req,res,next)=>{try{
  const result=await loans.detail(req.tenantDb,req.tenant,req.user,req.params.id);
  const funds=await fundsFor(req,'loans');
  renderTenant(req,res,'loans/detail','Loan '+result.loan.applicationRef,'Approved funds, outstanding balance and repayment evidence.',{
   ...result,funds,uuid:crypto.randomUUID(),format:shortFormat,
   canReview:hasPermission(req.user,'loans.review')&&String(result.loan.requestedBy)!==String(req.user.id)&&result.loan.status==='requested',
   canDisburse:hasPermission(req.user,'loans.disburse')&&result.loan.status==='approved',
   canRepay:hasPermission(req.user,'loans.repay')&&result.loan.status==='active',
   canCorrect:hasPermission(req.user,'loans.review')&&['Tenant Owner','Branch Manager'].includes(req.user.role),
   formatDate:value=>localDate(req,value)
  });
 }catch(e){next(e);}});
 router.post('/loans/:id/review',requirePermission('loans.review'),throttle,async(req,res,next)=>{try{
  const record=await loans.review(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good',record.status==='approved'?'Loan approved. No money is deducted until its documented disbursement.':'Loan application declined and retained for audit.');
  res.redirect(303,'/tenant/loans/'+req.params.id);
 }catch(e){next(e);}});
 router.post('/loans/:id/disburse',requirePermission('loans.disburse'),throttle,async(req,res,next)=>{try{
  await loans.disburse(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good','Loan disbursed. The actual funds account was deducted and the receivable journal posted once.');
  res.redirect(303,'/tenant/loans/'+req.params.id);
 }catch(e){next(e);}});
 router.post('/loans/:id/repayments/:paymentId/reverse',requirePermission('loans.review'),throttle,async(req,res,next)=>{try{
  await loans.reverseRepayment(req.tenantDb,req.tenant,req.user,req.params.id,req.params.paymentId,req.body);
  flash(req,'good','Repayment correction saved. The original receipt remains in history; the Treasury reversal and loan balance are updated together.');
  res.redirect(303,'/tenant/loans/'+req.params.id);
 }catch(e){next(e);}});
 router.post('/loans/:id/repay',requirePermission('loans.repay'),throttle,async(req,res,next)=>{try{
  const result=await loans.repay(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good',result.duplicate?'Repayment already recorded; no duplicate balance change.':'Loan repayment recorded. Cash and receivables updated, with interest recognized only on collection.');
  res.redirect(303,'/tenant/loans/'+req.params.id);
 }catch(e){next(e);}});
 async function airtimePage(req,res,next){try{
  const [result,funds]=await Promise.all([airtime.list(req.tenantDb,req.tenant,req.user),fundsFor(req,'airtime')]);
  renderTenant(req,res,'airtime/index','Airtime','Manual prepaid airtime stock, verified customer sales and exact profit.',{
   ...result,funds,canManage:hasPermission(req.user,'airtime.manage'),canSell:hasPermission(req.user,'airtime.sell'),
   canCorrect:hasPermission(req.user,'airtime.review')&&['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(req.user.role),
   format:shortFormat,uuid:crypto.randomUUID(),branch:req.operationBranch,
   activeCurrency:req.operationBranch?branchCurrency(req.operationBranch):null,
   currencyChoices:req.operationBranch?require('../services/branchCurrency.service').supported(req.operationBranch):[],
   saleUuid:crypto.randomUUID(),purchaseUuid:crypto.randomUUID()
  });
 }catch(e){next(e);}}
 router.get('/airtime',airtimePage);
 router.post('/airtime/products',requirePermission('airtime.manage'),throttle,async(req,res,next)=>{try{
  await airtime.createProduct(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good','Airtime product and fixed cost/retail prices saved. Historical prices will not change.');
  res.redirect(303,'/tenant/airtime');
 }catch(e){next(e);}});
 router.post('/airtime/stock',requirePermission('airtime.manage'),throttle,async(req,res,next)=>{try{
  const result=await airtime.purchase(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good',result.duplicate?'Stock purchase already recorded. No duplicate funds movement.':'Verified stock purchase recorded against the selected funding account.');
  res.redirect(303,'/tenant/airtime');
 }catch(e){next(e);}});
 router.post('/airtime/:id/reverse',requirePermission('airtime.review'),throttle,async(req,res,next)=>{try{
  await airtime.reverseRecorded(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good','Verified airtime reversal recorded; provider refund, inventory, funds and original audit evidence are reconciled.');
  res.redirect(303,'/tenant/airtime');
 }catch(e){next(e);}});
 router.post('/airtime/sales',requirePermission('airtime.sell'),throttle,async(req,res,next)=>{try{
  const result=await airtime.sell(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good',result.duplicate?'Sale already recorded. No duplicate cash or stock movement.':'Verified airtime sale recorded. Actual payment, inventory cost and profit were posted once.');
  res.redirect(303,'/tenant/airtime');
 }catch(e){next(e);}});
 return router;
};
