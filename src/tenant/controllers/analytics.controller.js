'use strict';
const service=require('../services/analytics.service');
// Controller is factory-injected with existing dashboard renderer to preserve
// the application's approved layout and noindex/private caching rules.
module.exports=function controller({renderTenant}){
 return {
  async index(req,res,next){try{
   const insights=await service.generate(req.tenantDb,req.tenant,req.user,req.query);
   res.setHeader('Cache-Control','private, no-store');
   renderTenant(req,res,'analytics/index','Advanced Analytics',
    'Independent operational insights from assigned and subscribed sources.',
    {insights,canExport:service.sourcesFor(req.tenant,req.user).length>0 &&
     require('../services/moduleAccess.service').hasPermission(req.user,'analytics.export')});
  }catch(e){next(e);}},
  async exportCsv(req,res,next){try{
   const insights=await service.generate(req.tenantDb,req.tenant,req.user,req.query);
   res.setHeader('Content-Type','text/csv; charset=utf-8');
   res.setHeader('Content-Disposition','attachment; filename="classicfin-analytics.csv"');
   res.setHeader('Cache-Control','private, no-store');
   res.send(service.csv(insights));
  }catch(e){next(e);}}
 };
};
