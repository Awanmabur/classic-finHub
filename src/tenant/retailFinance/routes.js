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
const {followRecord}=require('../services/branchView.service');
const throttle=require('../../platform/services/actionThrottle.service').financial;
const reportTimeZone=require('../services/reportTimeZone.service');
const reports=require('../services/operationsReports.service');
const reportAdapters={loans:require('../reporting/adapters/loans'),airtime:require('../reporting/adapters/airtime')};
const csvCell=require('../services/mobileMoney.service').csvCell;
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
   const canCreate=hasPermission(req.user,'loans.create');
   const [result,funds,customers]=await Promise.all([
    loans.list(req.tenantDb,req.tenant,req.user,{operatingBranchId:canCreate?req.operationBranch?._id:null}),fundsFor(req,'loans'),
    canCreate&&req.operationBranch?customerModel(req.tenantDb).find({branchId:req.operationBranch._id,status:'active'})
      .select('_id reference name').sort({name:1}).limit(250).lean():Promise.resolve([])
   ]);
   renderTenant(req,res,'loans/index','Loan Management','Borrower applications, independent review, funded disbursement and repayments.',{
    ...result,funds,customers,canManage:hasPermission(req.user,'loans.manage'),
    canCreate,format:shortFormat,uuid:crypto.randomUUID(),borrowerUuid:crypto.randomUUID(),
    branch:req.operationBranch,activeCurrency:req.operationBranch?branchCurrency(req.operationBranch):null,
    currencyChoices:req.operationBranch?require('../services/branchCurrency.service').supported(req.operationBranch):[],
    formatDate:value=>localDate(req,value)
   });
  }catch(error){next(error);}
 }
 async function moduleReport(req,res,next,key,exportCsv=false){
  try{
   const timeZone=await reportTimeZone.forRequest(req),filters=reports.parseFilters(req.query,[{key}],timeZone);
   const scope=reports.scopeFor(req.user);
   if(!['Tenant Owner','Auditor','Branch Manager','Reconciliation Officer','Reports Analyst','Analytics Analyst'].includes(req.user.role))
    scope.operatorId=String(req.user.id);
   const rows=await reportAdapters[key].rows({conn:req.tenantDb,tenant:req.tenant,user:req.user,filters,dateRange:filters.dateRange,scope});
   if(exportCsv){
    const content='\uFEFF'+[['Activity','Status','Currency','Records','Amount','Fees or profit'],
      ...rows.map(row=>[row.activity,row.status,row.currency,row.count,row.volume,row.fees])]
      .map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
    res.set({'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow'});
    return res.attachment('classicfin-'+key+'-summary-'+filters.from+'-'+filters.to+'.csv').type('text/csv').send(content);
   }
   renderTenant(req,res,'retailFinance/module-report',key==='loans'?'Loan Management summary report':'Airtime summary report',
    'Module activity grouped by currency, status and operation; corrections stay visible.',{
     moduleKey:key,rows,filters,timeZone,label:key==='loans'?'Loan Management':'Airtime',home:'/tenant/'+key,canExport:true
    });
  }catch(error){next(error);}
 }
 router.get('/loans/report',(req,res,next)=>moduleReport(req,res,next,'loans'));
 router.get('/loans/report/export.csv',(req,res,next)=>moduleReport(req,res,next,'loans',true));
 router.get('/airtime/report',(req,res,next)=>moduleReport(req,res,next,'airtime'));
 router.get('/airtime/report/export.csv',(req,res,next)=>moduleReport(req,res,next,'airtime',true));
 router.get('/loans',loanPage);
 router.post('/loans/borrowers',requirePermission('loans.create'),throttle,async(req,res,next)=>{try{
  const result=await loans.registerBorrower(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good',result.duplicate?'Borrower already registered; no duplicate created.':'Borrower registered. Select this customer when submitting a loan application.');
  res.redirect(303,'/tenant/loans');
 }catch(e){next(e);}});
 router.post('/loans/products',requirePermission('loans.manage'),throttle,async(req,res,next)=>{try{
  await loans.createProduct(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good','Loan product saved with immutable terms and an audit record.');
  res.redirect(303,'/tenant/loans');
 }catch(e){next(e);}});
 router.post('/loans/applications',requirePermission('loans.create'),throttle,async(req,res,next)=>{try{
  const {loan,duplicate}=await loans.apply(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good',duplicate?'Loan application already recorded. No duplicate created.':'Loan application submitted for independent review. No funds have been disbursed.');
  followRecord(req,loan);
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
  followRecord(req,record);
  res.redirect(303,'/tenant/loans/'+req.params.id);
 }catch(e){next(e);}});
 router.post('/loans/:id/disburse',requirePermission('loans.disburse'),throttle,async(req,res,next)=>{try{
  const record=await loans.disburse(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good','Documented loan disbursement recorded. The selected funds account was deducted and the receivable journal was posted once; no external payment was initiated.');
  followRecord(req,record);
  res.redirect(303,'/tenant/loans/'+req.params.id);
 }catch(e){next(e);}});
 const retailReceipt=require('./receipts.service');
 function showReceipt(req,res,next,reader){
  Promise.resolve().then(()=>reader(req.tenantDb,req.tenant,req.user)).then(receipt=>{
   res.set({'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'});
   res.render('tenant/retailFinance/acknowledgement',{receipt,identity:req.workspaceIdentity||{},autoPrint:!receipt.reversed&&req.query.autoPrint==='1'});
  }).catch(next);
 }
 router.get('/loans/:id/repayments/:paymentId/receipt',requirePermission('loans.view'),(req,res,next)=>
  showReceipt(req,res,next,(conn,tenant,user)=>retailReceipt.loanPayment(conn,tenant,user,req.params.id,req.params.paymentId)));
 router.get('/airtime/:id/receipt',requirePermission('airtime.view'),(req,res,next)=>
  showReceipt(req,res,next,(conn,tenant,user)=>retailReceipt.airtimeSale(conn,tenant,user,req.params.id)));
 router.post('/loans/:id/repayments/:paymentId/reverse',requirePermission('loans.review'),throttle,async(req,res,next)=>{try{
  const correction=await loans.reverseRepayment(req.tenantDb,req.tenant,req.user,req.params.id,req.params.paymentId,req.body);
  flash(req,'good','Repayment correction saved. The original receipt remains in history; the Treasury reversal and loan balance are updated together.');
  followRecord(req,correction);
  res.redirect(303,'/tenant/loans/'+req.params.id);
 }catch(e){next(e);}});
 router.post('/loans/:id/repay',requirePermission('loans.repay'),throttle,async(req,res,next)=>{try{
  const result=await loans.repay(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good',result.duplicate?'Repayment already recorded; no duplicate balance change.':'Loan repayment recorded. Cash and receivables updated, with interest recognized only on collection.');
  followRecord(req,result.payment);
  res.redirect(303,require('../services/receiptPrint.service').loan(result)||'/tenant/loans/'+req.params.id);
 }catch(e){next(e);}});
 async function airtimePage(req,res,next){try{
  const canSell=hasPermission(req.user,'airtime.sell');
  const [result,funds]=await Promise.all([
   airtime.list(req.tenantDb,req.tenant,req.user,{operatingBranchId:canSell?req.operationBranch?._id:null}),
   fundsFor(req,'airtime')
  ]);
  renderTenant(req,res,'airtime/index','Airtime','Manual prepaid airtime stock, verified customer sales and exact profit.',{
   ...result,funds,canManage:hasPermission(req.user,'airtime.manage'),canSell,
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
  flash(req,'good',result.duplicate?'Stock purchase already recorded. No duplicate funds movement.':'Operator-recorded stock purchase saved against the selected funding account and supplier evidence.');
  followRecord(req,result.record);
  res.redirect(303,'/tenant/airtime');
 }catch(e){next(e);}});
 router.post('/airtime/:id/reverse',requirePermission('airtime.review'),throttle,async(req,res,next)=>{try{
  const correction=await airtime.reverseRecorded(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good','Airtime reversal recorded from reviewer-confirmed refund evidence; inventory and funds books were adjusted and the original record retained.');
  followRecord(req,correction);
  res.redirect(303,'/tenant/airtime');
 }catch(e){next(e);}});
 router.post('/airtime/sales',requirePermission('airtime.sell'),throttle,async(req,res,next)=>{try{
  const result=await airtime.sell(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good',result.duplicate?'Sale already recorded. No duplicate cash or stock movement.':'Operator-confirmed airtime sale recorded against supplied delivery evidence. The selected funds account, stock cost and gross profit were posted once.');
  followRecord(req,result.record);
  res.redirect(303,require('../services/receiptPrint.service').airtime(result)||'/tenant/airtime');
 }catch(e){next(e);}});
 return router;
};
