'use strict';
const service=require('../services/analytics.service');
const reportTimeZone=require('../services/reportTimeZone.service');
// Controller is factory-injected with existing dashboard renderer to preserve
// the application's approved layout and noindex/private caching rules.
module.exports=function controller({renderTenant}){
 return {
  async index(req,res,next){try{
   let timeZone;
   try{timeZone=await reportTimeZone.forRequest(req);}
   catch(error){
    if(error.status!==409)throw error;
    res.setHeader('Cache-Control','private, no-store');
    return renderTenant(req,res,'analytics/index','Analytics','Compare activity across business days.',
     {scopeNotice:'Select a branch in the header. These branches use different time zones.'});
   }
   const insights=await service.generate(req.tenantDb,req.tenant,req.user,req.query,new Date(),timeZone);
   res.setHeader('Cache-Control','private, no-store');
   renderTenant(req,res,'analytics/index','Analytics','Compare activity across business days.',
    {insights,canExport:insights.data.length>0 &&
     require('../services/moduleAccess.service').hasPermission(req.user,'analytics.export')});
  }catch(e){next(e);}},
  async exportCsv(req,res,next){try{
   const timeZone=await reportTimeZone.forRequest(req);
   const insights=await service.generate(req.tenantDb,req.tenant,req.user,req.query,new Date(),timeZone,{charts:false});
   res.setHeader('Content-Type','text/csv; charset=utf-8');
   res.setHeader('Content-Disposition','attachment; filename="classicfin-analytics.csv"');
   res.setHeader('Cache-Control','private, no-store');
   res.send(service.csv(insights));
  }catch(e){next(e);}}
 };
};
