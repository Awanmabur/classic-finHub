'use strict';
const routerFactory=require('express').Router;
const requirePermission=require('../../middleware/requirePermission');
const workspace=require('../services/operationWorkspace.service');
const reportTimeZone=require('../services/reportTimeZone.service');
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
   const timeZone=await reportTimeZone.forRequest(req);
   const data=await workspace.report(req.tenantDb,req.tenant,req.user,moduleKey,req.query,timeZone);
   Object.assign(data,{basePath:`/tenant/${definition.path}`,title,...options});
   if(options.records)data.records=await workspace.records(req.tenantDb,req.tenant,req.user,moduleKey,req.query,timeZone);
   // Module summary pages have their own rendering route. Supply the same
   // real ledger-backed statistics as the module entry page, scoped to the
   // report period rather than a misleading unfiltered "today".
   try{
    data.financeOverview=await require('../services/financeOverview.service').moduleOverview(
     req.tenantDb,req.tenant,req.user,req.operationBranch,
     {moduleKey,from:data.filters.from,to:data.filters.to,timeZone,viewBranchId:req.viewBranchId,viewBranch:req.viewBranch}
    );
   }catch(overviewError){
    console.error('MODULE_REPORT_OVERVIEW_UNAVAILABLE',{moduleKey,requestId:req.id||null,error:overviewError.message});
    data.financeOverview={available:false,reason:'Financial overview temporarily unavailable; detailed report remains available'};
   }
   renderTenant(req,res,`${definition.path}/${view}`,title,'Filter and review records in your authorized workspace.',data);
  }catch(error){next(error);}
 };
 for(const [path,title,operation] of spec.forms){
  router.get(path,async(req,res,next)=>{
   try{
    const data=await workspace.formContext(req.tenantDb,req.tenant,req.user,moduleKey,req.operationBranch,req.query);
    data.financeOverview=await require('../services/financeOverview.service').moduleOverview(
     req.tenantDb,req.tenant,req.user,req.operationBranch,{moduleKey,viewBranchId:req.viewBranchId,viewBranch:req.viewBranch});
    if(moduleKey==='forex')data.rateDisplay=require('../services/forexRateUnits.service').display;
    data.canFx=require('../services/moduleAccess.service').hasModuleForUser(req.tenant,req.user,'forex')&&
     require('../services/moduleAccess.service').hasPermission(req.user,'forex.quotes.create');
    Object.assign(data,{workspaceTitle:title,workspaceOperation:operation,
     originModule:'forex',originRecordId:''});
    renderTenant(req,res,`${definition.path}/index`,title,moduleKey==='forex'?'Real Buy/Sell exchange quotations and direct cashier-confirmed Treasury posting.':'Record instructions and review their status.',data);
   }catch(error){next(error);}
  });
 }
 router.get('/records',(req,res,next)=>render(req,res,next,'workspace',spec.recordTitle,{records:true,mode:'records'}));
 router.get('/report',(req,res,next)=>render(req,res,next,'workspace',spec.reportTitle,{mode:'report'}));
 router.get('/report/export.csv',async(req,res,next)=>{
  try{
   const timeZone=await reportTimeZone.forRequest(req);
   const report=await workspace.report(req.tenantDb,req.tenant,req.user,moduleKey,req.query,timeZone);
   if(!report.canExport)throw workspace.fail('Report export permission required',403);
   res.setHeader('Cache-Control','private, no-store');
   res.attachment(`${definition.path}-report-${report.filters.from}-${report.filters.to}.csv`).type('text/csv').send(workspace.csv(report));
  }catch(error){next(error);}
 });
 if(moduleKey==='money_transfer'){
  router.get('/fees',(req,res,next)=>render(req,res,next,'workspace','Transfer fee summary',{mode:'fees'}));
  router.get('/pending-payouts',async(req,res,next)=>{
   // Only independently reviewed collections are eligible for manual PIN payout.
   try{
    const filters={...req.query,status:'collected_manual'};
    const timeZone=await reportTimeZone.forRequest(req);
    const data=await workspace.report(req.tenantDb,req.tenant,req.user,moduleKey,filters,timeZone);
    data.records=await workspace.records(req.tenantDb,req.tenant,req.user,moduleKey,filters,timeZone);
    data.financeOverview=await require('../services/financeOverview.service').moduleOverview(
     req.tenantDb,req.tenant,req.user,req.operationBranch,
     {moduleKey,from:data.filters.from,to:data.filters.to,timeZone,viewBranchId:req.viewBranchId,viewBranch:req.viewBranch}
    );
    Object.assign(data,{basePath:'/tenant/money-transfer',title:'Pending payout queue',mode:'pending'});
    renderTenant(req,res,'money-transfer/workspace',data.title,'Independently reviewed manual collections awaiting receiver verification and payout.',data);
   }catch(error){next(error);}
  });
  router.get('/payout',requirePermission('money_transfer.payout'),(req,res)=>res.redirect(303,'/tenant/funded/payout'));
 }
 if(moduleKey==='banking')router.get('/movements',(req,res,next)=>render(req,res,next,'workspace','Banking request movements',{mode:'records',records:true}));
 if(moduleKey==='forex'){
  router.get('/cash-impact',(req,res,next)=>render(req,res,next,'workspace','Forex cash impact',{mode:'cash'}));
  router.get('/cash-stock',(req,res,next)=>res.redirect(303,'/tenant/forex/cash-impact'));
  router.get('/rates',async(req,res,next)=>{
   try{const data=await workspace.formContext(req.tenantDb,req.tenant,req.user,moduleKey,req.operationBranch,req.query);
    data.rateDisplay=require('../services/forexRateUnits.service').display;
    data.rates=await require('../services/forex.service').listRates(req.tenantDb,req.tenant,req.user,{status:'active'});
    data.financeOverview=await require('../services/financeOverview.service').moduleOverview(
     req.tenantDb,req.tenant,req.user,req.operationBranch,{moduleKey,viewBranchId:req.viewBranchId,viewBranch:req.viewBranch});
    Object.assign(data,{workspaceTitle:'Active rate board',workspaceOperation:'rates'});
    renderTenant(req,res,'forex/index','Active rate board','Approved indicative exchange rates and independent review.',data);
   }catch(error){next(error);}
  });
 }
 return router;
};
