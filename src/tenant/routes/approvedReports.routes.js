'use strict';
const crypto=require('node:crypto');
const requireModule=require('../../middleware/requireModule');
const requirePermission=require('../../middleware/requirePermission');
const {hasPermission,hasModuleForUser}=require('../services/moduleAccess.service');
const {currencyLabel}=require('../../config/currencies');
const businessTime=require('../../utils/businessTime');
const branchView=require('../services/branchView.service');
const reports=require('../services/approvedReports.service');
const summary=require('../services/ownerReportSummary.service');
const operations=require('../services/operationsReports.service');
const financeOverview=require('../services/financeOverview.service');
const cashDrawer=require('../services/cashDrawer.service');
const {amountLabel}=require('../services/forex.service');
const reportTimeZone=require('../services/reportTimeZone.service');
function generalContext(req,branches){
 if(branchView.canViewBranches(req.user))return summary.scopeForRequest(req,branches);
 return {branchName:req.operationBranch?.name,timeZone:businessTime.forBranch(req.operationBranch),allBranches:false};
}
async function financialDetails(req,filters){
 const options={...filters,operationBranch:req.operationBranch,viewBranch:req.viewBranch,
  viewBranchId:req.viewBranchId,scopeToAssignedModules:true,includeAccounts:true};
 const [finance,cash]=await Promise.allSettled([
  financeOverview.overview(req.tenantDb,req.tenant,req.user,options),
  cashDrawer.expectedCash(req.tenantDb,req.tenant,req.user,req.operationBranch)
 ]);
 for(const [source,result] of [['assets',finance],['drawers',cash]]){
  if(result.status==='rejected')console.warn(JSON.stringify({
   event:'reports.financial_details_unavailable',source,code:String(result.reason?.code||result.reason?.name||'UNKNOWN').slice(0,80)
  }));
 }
 return {finance:finance.value,expectedCash:cash.value||[],
  financeNotice:finance.status==='rejected'||cash.status==='rejected'?'Some balances could not be loaded. Refresh to try again.':null};
}
module.exports=function approvedReportsRoutes({renderTenant}){
 const router=require('express').Router();
 const guard=[requireModule('reports'),requirePermission('reports.view')];
 router.get('/reports',...guard,async(req,res,next)=>{
  try {
   const context=generalContext(req,res.locals.viewBranches);
   const report=await operations.generate(req.tenantDb,req.tenant,req.user,req.query,context.timeZone);
   const details=await financialDetails(req,report.filters);
   renderTenant(req,res,'reports/index','General reports','', {
    ...details,report,context,currencyLabel,canExport:hasPermission(req.user,'reports.export'),
    branchNames:new Map((res.locals.viewBranches||[]).map(branch=>[String(branch._id),branch.name]))
   });
  } catch(error){next(error);}
 });
 router.get('/reports/export.csv',requireModule('reports'),requirePermission('reports.export'),async(req,res,next)=>{
  try {
   const {timeZone}=generalContext(req,res.locals.viewBranches);
   const report=await operations.generate(req.tenantDb,req.tenant,req.user,req.query,timeZone);
   res.set('Cache-Control','private, no-store');
   res.attachment('classicfin-operations-report.csv').type('text/csv; charset=utf-8').send(operations.csv(report));
  } catch(error){next(error);}
 });
 router.get('/reports/summary',...guard,async(req,res,next)=>{
  try {
   const data=await summary.generate(req,res.locals.viewBranches);
   if(data.formError)res.status(400);
   renderTenant(req,res,'reports/summary','Business summary','', {
    ...data,canExport:!data.formError&&hasPermission(req.user,'reports.export'),currencyLabel,
    formatMoney:(value,currency)=>amountLabel(value,currency).replace(/^KES /,'KSH ')
   });
  } catch(error){next(error);}
 });
 router.get('/reports/summary/export.csv',...guard,requirePermission('reports.export'),async(req,res,next)=>{
  try {
   const {report,formError}=await summary.generate(req,res.locals.viewBranches);
   if(formError)return res.status(400).type('text/plain').send(formError);
   res.set('Cache-Control','private, no-store');
   res.attachment('classicfin-business-summary.csv').type('text/csv; charset=utf-8').send(summary.csv(report));
  } catch(error){next(error);}
 });
 for(const key of Object.keys(reports.pages)){
  router.get(`/reports/${key}/export.csv`,...guard,requirePermission('reports.export'),async(req,res,next)=>{try{
   const timeZone=await reportTimeZone.forRequest(req);
   const report=await reports.generate(req.tenantDb,req.tenant,req.user,key,req.query,timeZone);
   if(!report.sourceAvailable){const error=new Error('This report source is not assigned to your account or subscription');error.status=403;throw error;}
   res.set('Cache-Control','private, no-store');res.set('Content-Disposition',`attachment; filename="classicfin-${key}.csv"`);
   res.type('text/csv; charset=utf-8').send(reports.csv(report));
  }catch(error){next(error);}});
  router.get(`/reports/${key}`,...guard,async(req,res,next)=>{try{
   const timeZone=await reportTimeZone.forRequest(req);
   const report=await reports.generate(req.tenantDb,req.tenant,req.user,key,req.query,timeZone);
   renderTenant(req,res,'reports/approved',report.page.title,report.page.subtitle,{report,canExport:hasPermission(req.user,'reports.export'),
    canCreateExpense:hasModuleForUser(req.tenant,req.user,'expenses')&&hasPermission(req.user,'expenses.create'),idempotencyKey:crypto.randomUUID(),openModal:false});
  }catch(error){next(error);}});
 }
 router.get('/reports/print',...guard,async(req,res,next)=>{try{
  const timeZone=await reportTimeZone.forRequest(req);
  const report=await reports.generate(req.tenantDb,req.tenant,req.user,'daily',req.query,timeZone);
  renderTenant(req,res,'reports/approved','Daily business report',report.page.subtitle,{report,canExport:hasPermission(req.user,'reports.export'),canCreateExpense:false,print:true});
 }catch(error){next(error);}});
 return router;
};
