'use strict';
const crypto=require('node:crypto');
const requireModule=require('../../middleware/requireModule');
const requirePermission=require('../../middleware/requirePermission');
const {hasPermission,hasModuleForUser}=require('../services/moduleAccess.service');
const {currencyLabel}=require('../../config/currencies');
const reports=require('../services/approvedReports.service');
const summary=require('../services/ownerReportSummary.service');
const {amountLabel}=require('../services/forex.service');
const reportTimeZone=require('../services/reportTimeZone.service');
module.exports=function approvedReportsRoutes({renderTenant}){
 const router=require('express').Router();
 const guard=[requireModule('reports'),requirePermission('reports.view')];
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
