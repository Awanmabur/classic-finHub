'use strict';
const {randomUUID}=require('node:crypto');
const requirePermission=require('../../middleware/requirePermission');
const requireModule=require('../../middleware/requireModule');
const {hasPermission}=require('../services/moduleAccess.service');
const branchService=require('../services/branch.service');
const workspace=require('../services/mobileMoneyWorkspace.service');
module.exports=function routes({renderTenant}){
 const router=require('express').Router();
 router.use(requireModule('mobile_money'),requirePermission('mobile_money.view'));
 async function render(req,res,next,{view,title,subtitle,operation,report=false}){
  try{
   if(report&&!workspace.canReport(req.user))return res.status(403).send('Mobile money report permission is required.');
   const [data,branches,pricingContext]=await Promise.all([
    workspace.workspace(req.tenantDb,req.user,req.query,{operation}),branchService.list(req.tenant),
    operation?require('../pricing/presentation').context(req.tenantDb,req.tenant,req.operationBranch,'mobile_money'):[]
   ]);
   const commissionReceived=view==='network'&&hasPermission(req.user,'treasury.view')?
    await require('../pricing/commissionPayoutService').summary(req.tenantDb,req.tenant,req.user):[];
   const branchCurrency=require('../services/branchCurrency.service');
   renderTenant(req,res,`mobile-money/${view}`,title,subtitle,{...data,operation,pricingContext,commissionReceived,idempotencyKey:randomUUID(),
    entryCurrency:req.operationBranch&&operation?branchCurrency.resolve(req.operationBranch,req.query.currency):null,
    entryCurrencies:req.operationBranch?branchCurrency.options(req.operationBranch):[],
    branches:branches.filter(branch=>branch.status==='active'&&(req.user.role==='Tenant Owner'||String(branch._id)===String(req.user.branchId))),
    selectedBranchId:req.operationBranch?String(req.operationBranch._id):null,
    funds:req.operationBranch&&hasPermission(req.user,'treasury.view')?await require('../services/mobileMoneyFunds.service').context(req.tenantDb,req.tenant,req.user,req.operationBranch):null,
    canRecord:operation?hasPermission(req.user,`mobile_money.${operation}`):hasPermission(req.user,'mobile_money.cash_in')||hasPermission(req.user,'mobile_money.cash_out'),
    recordPath:hasPermission(req.user,'mobile_money.cash_in')?'/tenant/mobile-money/cash-in':'/tenant/mobile-money/cash-out'});
  }catch(error){next(error);}
 }
 router.get('/funds/context',async(req,res,next)=>{try{if(!req.operationBranch)return res.status(409).json({error:'An operating branch is required.'});res.set('Cache-Control','private, no-store').json(await require('../services/mobileMoneyFunds.service').context(req.tenantDb,req.tenant,req.user,req.operationBranch));}catch(error){next(error);}});
 router.get('/cash-in',(req,res,next)=>render(req,res,next,{view:'entry',title:'Cash-in',subtitle:'Cash-in/cash-out activity and cash drawer impact.',operation:'cash_in'}));
 router.get('/cash-out',(req,res,next)=>render(req,res,next,{view:'entry',title:'Cash-out',subtitle:'Cash-in/cash-out activity and cash drawer impact.',operation:'cash_out'}));
 router.get('/network-activity',(req,res,next)=>render(req,res,next,{view:'network',title:'Network activity',subtitle:'Mobile money records grouped by network with recent activity.'}));
 router.get('/cash-impact',(req,res,next)=>render(req,res,next,{view:'cash-impact',title:'Mobile money cash impact',subtitle:'Cash-in, cash-out, commission, and net drawer movement for mobile money.'}));
 router.get('/report',(req,res,next)=>render(req,res,next,{view:'report',title:'Mobile money report',subtitle:'Dedicated report for mobile money count, volume, network mix, and drawer impact.',report:true}));
 router.get('/report/export.csv',async(req,res,next)=>{
  try{
   const result=await workspace.exportCsv(req.tenantDb,req.user,req.query);
   res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="mobile-money-${result.filters.from}-${result.filters.to}.csv"`,'Cache-Control':'private, no-store'});
   res.send(result.csv);
  }catch(error){next(error);}
 });
 return router;
};
