'use strict';
const crypto=require('node:crypto');
const requireModule=require('../../middleware/requireModule');
const requirePermission=require('../../middleware/requirePermission');
const {hasPermission,hasModuleForUser}=require('../services/moduleAccess.service');
const reports=require('../services/approvedReports.service');
module.exports=function approvedReportsRoutes({renderTenant}){
 const router=require('express').Router();
 const guard=[requireModule('reports'),requirePermission('reports.view')];
 for(const key of Object.keys(reports.pages)){
  router.get(`/reports/${key}/export.csv`,...guard,requirePermission('reports.export'),async(req,res,next)=>{try{
   const report=await reports.generate(req.tenantDb,req.tenant,req.user,key,req.query);
   if(!report.sourceAvailable){const error=new Error('This report source is not assigned to your account or subscription');error.status=403;throw error;}
   res.set('Cache-Control','private, no-store');res.set('Content-Disposition',`attachment; filename="classicfin-${key}.csv"`);
   res.type('text/csv; charset=utf-8').send(reports.csv(report));
  }catch(error){next(error);}});
  router.get(`/reports/${key}`,...guard,async(req,res,next)=>{try{
   const report=await reports.generate(req.tenantDb,req.tenant,req.user,key,req.query);
   renderTenant(req,res,'reports/approved',report.page.title,report.page.subtitle,{report,canExport:hasPermission(req.user,'reports.export'),
    canCreateExpense:hasModuleForUser(req.tenant,req.user,'expenses')&&hasPermission(req.user,'expenses.create'),idempotencyKey:crypto.randomUUID(),openModal:false});
  }catch(error){next(error);}});
 }
 router.get('/reports/print',...guard,async(req,res,next)=>{try{
  const report=await reports.generate(req.tenantDb,req.tenant,req.user,'daily',req.query);
  renderTenant(req,res,'reports/approved','Daily business report',report.page.subtitle,{report,canExport:hasPermission(req.user,'reports.export'),canCreateExpense:false,print:true});
 }catch(error){next(error);}});
 return router;
};
