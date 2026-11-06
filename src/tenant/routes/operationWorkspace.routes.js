'use strict';
const routerFactory=require('express').Router;
const requirePermission=require('../../middleware/requirePermission');
const workspace=require('../services/operationWorkspace.service');
const specs=Object.freeze({
 money_transfer:{recordTitle:'Money transfer record',reportTitle:'Transfer report summary',forms:[['/send','Send money / Generate PIN','']]},
 banking:{recordTitle:'Account movements',reportTitle:'Banking report summary',forms:[['/deposit','Deposit','deposit_request'],['/withdraw','Withdraw','withdrawal_request'],['/transfer','Account transfer','transfer_request']]},
 forex:{recordTitle:'Forex operation records',reportTitle:'Forex report summary',forms:[['/buy','Buy forex from customer','buy'],['/sell','Sell forex to customer','sell']]}
});
module.exports=function operationWorkspaceRoutes({renderTenant,moduleKey}){
 const router=routerFactory(),definition=workspace.definition(moduleKey),spec=specs[moduleKey];
 router.use(requirePermission(`${moduleKey}.view`));
 const render=async(req,res,next,view,title,options={})=>{
  try{
   const data=await workspace.report(req.tenantDb,req.tenant,req.user,moduleKey,req.query);
   Object.assign(data,{basePath:`/tenant/${definition.path}`,title,...options});
   if(options.records)data.records=await workspace.records(req.tenantDb,req.tenant,req.user,moduleKey,req.query);
   renderTenant(req,res,`${definition.path}/${view}`,title,'Filter and review records in your authorized workspace.',data);
  }catch(error){next(error);}
 };
 for(const [path,title,operation] of spec.forms){
  router.get(path,async(req,res,next)=>{
   try{
    const data=await workspace.formContext(req.tenantDb,req.tenant,req.user,moduleKey,req.operationBranch);
    Object.assign(data,{workspaceTitle:title,workspaceOperation:operation});
    renderTenant(req,res,`${definition.path}/index`,title,moduleKey==='forex'?'Customer exchange quotations with approved rates and independent review.':'Record instructions and review their status.',data);
   }catch(error){next(error);}
  });
 }
 router.get('/records',(req,res,next)=>render(req,res,next,'workspace',spec.recordTitle,{records:true,mode:'records'}));
 router.get('/report',(req,res,next)=>render(req,res,next,'workspace',spec.reportTitle,{mode:'report'}));
 router.get('/report/export.csv',async(req,res,next)=>{
  try{
   const report=await workspace.report(req.tenantDb,req.tenant,req.user,moduleKey,req.query);
   if(!report.canExport)throw workspace.fail('Report export permission required',403);
   res.setHeader('Cache-Control','private, no-store');
   res.attachment(`${definition.path}-report-${report.filters.from}-${report.filters.to}.csv`).type('text/csv').send(workspace.csv(report));
  }catch(error){next(error);}
 });
 if(moduleKey==='money_transfer'){
  router.get('/fees',(req,res,next)=>render(req,res,next,'workspace','Transfer fee summary',{mode:'fees'}));
  router.get('/pending-payouts',async(req,res,next)=>{
   // Approved internal instructions remain pending provider execution. No PIN
   // or paid-out state is invented from an internal reviewer decision.
   try{
    const filters={...req.query,status:'approved_pending_provider'};
    const data=await workspace.report(req.tenantDb,req.tenant,req.user,moduleKey,filters);
    data.records=await workspace.records(req.tenantDb,req.tenant,req.user,moduleKey,filters);
    Object.assign(data,{basePath:'/tenant/money-transfer',title:'Pending payout queue',mode:'pending'});
    renderTenant(req,res,'money-transfer/workspace',data.title,'Approved transfer instructions awaiting verified provider execution.',data);
   }catch(error){next(error);}
  });
  router.get('/payout',(req,res,next)=>render(req,res,next,'workspace','Payout by PIN',{mode:'payout',records:true}));
 }
 if(moduleKey==='banking')router.get('/movements',(req,res,next)=>render(req,res,next,'workspace','Banking request movements',{mode:'records',records:true}));
 if(moduleKey==='forex'){
  router.get('/cash-impact',(req,res,next)=>render(req,res,next,'workspace','Forex cash impact',{mode:'cash'}));
  router.get('/cash-stock',(req,res,next)=>res.redirect(303,'/tenant/forex/cash-impact'));
  router.get('/rates',async(req,res,next)=>{
   try{const data=await workspace.formContext(req.tenantDb,req.tenant,req.user,moduleKey,req.operationBranch);
    Object.assign(data,{workspaceTitle:'Active rate board',workspaceOperation:'rates'});
    renderTenant(req,res,'forex/index','Active rate board','Approved indicative exchange rates and independent review.',data);
   }catch(error){next(error);}
  });
 }
 return router;
};
