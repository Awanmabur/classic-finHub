'use strict';
const {randomUUID}=require('node:crypto');
const requirePermission=require('../../middleware/requirePermission');
const requireModule=require('../../middleware/requireModule');
const {hasPermission}=require('../services/moduleAccess.service');
const branchService=require('../services/branch.service');
const workspace=require('../services/mobileMoneyWorkspace.service');
const businessTime=require('../../utils/businessTime');
const reportTimeZone=require('../services/reportTimeZone.service');
module.exports=function routes({renderTenant}){
 const router=require('express').Router();
 router.use(requireModule('mobile_money'),requirePermission('mobile_money.view'));
 async function render(req,res,next,{view,title,subtitle,operation,report=false}){
  try{
   if(report&&!workspace.canReport(req.user))return res.status(403).send('Mobile money report permission is required.');
   const reportZone=operation?businessTime.forBranch(req.operationBranch):await reportTimeZone.forRequest(req);
   const funds=req.operationBranch?await require('../services/mobileMoneyFunds.service').context(
    req.tenantDb,req.tenant,req.user,req.operationBranch):null;
   const market=require('../services/mobileMoneyMarket.service');
   const realWallets=(funds?.wallets||[]).filter(wallet=>!operation||wallet.shared||wallet.assignedToOperator);
   const marketOptions=market.markets(realWallets);
   const filters=market.withDefaultFilters(req.query,realWallets);
   const reportData=report?await require('../services/mobileMoneyUnifiedReport.service').generate(
    req.tenantDb,req.tenant,req.user,filters,reportZone):null;
   const [data,branches,pricingContext]=await Promise.all([
    workspace.workspace(req.tenantDb,req.user,report?{}:filters,{operation,timeZone:reportZone}),branchService.list(req.tenant),
    operation?require('../pricing/presentation').context(req.tenantDb,req.tenant,req.operationBranch,'mobile_money'):[]
   ]);
   const commissionReceived=view==='network'&&hasPermission(req.user,'treasury.view')?
    await require('../pricing/commissionPayoutService').summary(req.tenantDb,req.tenant,req.user):[];
   const branchCurrency=require('../services/branchCurrency.service');
   const selectedMarket=market.preferred(realWallets);
   // Mobile Money currency follows the configured network, not the branch's
   // unrelated default (Sherikat's branch default is USD, MTN UG uses UGX).
   const mobileCurrency=req.operationBranch&&selectedMarket?
    branchCurrency.resolve(req.operationBranch,selectedMarket.currency):
    req.operationBranch&&operation?branchCurrency.resolve(req.operationBranch,req.query.currency):null;
   const financeOverview=['report','cash-impact','network'].includes(view)?
    await require('../services/financeOverview.service').moduleOverview(
     req.tenantDb,req.tenant,req.user,req.operationBranch,{
      ...(reportData?.window?{from:reportData.window.from,to:reportData.window.to}:{}),
      timeZone:reportZone,viewBranchId:req.viewBranchId,viewBranch:req.viewBranch
     }):undefined;
   renderTenant(req,res,`mobile-money/${view}`,title,subtitle,{...data,financeOverview,reportData,networkMarkets:marketOptions,networksAvailable:marketOptions.length?[...new Set(marketOptions.map(x=>x.network))]:data.networksAvailable,filters:report?{...data.filters,network:filters.network||'',currency:filters.currency||'',from:reportData.window.from,to:reportData.window.to}:data.filters,operation,pricingContext,commissionReceived,formatMoneyMinor:require('../services/mobileMoney.service').formatMoneyMinor,idempotencyKey:randomUUID(),
    entryCurrency:operation?mobileCurrency:null,mobileMoneySelectedCurrency:selectedMarket?.currency||null,
    entryCurrencies:req.operationBranch?branchCurrency.options(req.operationBranch):[],
    branches:branches.filter(branch=>branch.status==='active'&&(req.user.role==='Tenant Owner'||String(branch._id)===String(req.user.branchId))),
    selectedBranchId:req.operationBranch?String(req.operationBranch._id):null,
    funds,
    canRecord:operation?hasPermission(req.user,`mobile_money.${operation}`):hasPermission(req.user,'mobile_money.cash_in')||hasPermission(req.user,'mobile_money.cash_out'),
    recordPath:hasPermission(req.user,'mobile_money.cash_in')?'/tenant/mobile-money/cash-in':'/tenant/mobile-money/cash-out'});
  }catch(error){next(error);}
 }
 router.post('/fx/record',requirePermission('treasury.observe'),
  require('../../platform/services/actionThrottle.service').financial,
  async(req,res,next)=>{
   try{
    if(!req.operationBranch)return res.status(409).send('Choose an operating branch');
    // The service re-reads branch, rate, wallet, drawer and grants in the SAME
    // database transaction. Form snapshots are never trusted for posting.
    const result=await require('../services/momoFxSettlement.service').settleManuallyConfirmed(
     req.tenantDb,req.tenant,req.user,{...req.body,branchId:String(req.operationBranch._id)});
    require('../../utils/view').flash(req,'good',result.duplicate?
     'This exchange was already recorded; no duplicate posted.':
     'Exchange finalized in FinHub cash and float books. External provider settlement remains unverified.');
    res.redirect(303,'/tenant/mobile-money/fx/history');
   }catch(e){next(e);}
  });
 router.get('/fx/history',async(req,res,next)=>{
  try{
   if(!req.operationBranch||!hasPermission(req.user,'treasury.view')||
      !hasPermission(req.user,'forex.view')||
      !require('../services/moduleAccess.service').hasModuleForUser(req.tenant,req.user,'forex'))
    return res.status(403).send('Cross-currency reporting access is required');
   const scope={tenantId:req.tenant._id,branchId:req.operationBranch._id};
   if(!['Tenant Owner','Branch Manager','Reconciliation Officer','Auditor'].includes(req.user.role))
    scope.actorId=req.user.id;
   const records=await require('../schemas/MomoFxSettlement').records(req.tenantDb)
    .find(scope).sort({settledAt:-1,_id:-1}).limit(100).lean();
   res.set('Cache-Control','private, no-store');
   renderTenant(req,res,'mobile-money/fx-history','Cross-currency history',
     'Immutable completed cross-currency operations; each pair of native-currency journals belongs to one customer operation.',
     {records,formatMoneyMinor:require('../services/mobileMoney.service').formatMoneyMinor});
  }catch(e){next(e);}
 });
 router.get('/fx',async(req,res,next)=>{
  try{
   if(!req.operationBranch)return res.status(409).send('Select an operating branch');
   if(!hasPermission(req.user,'treasury.view')||!hasPermission(req.user,'forex.view')||
      !require('../services/moduleAccess.service').hasModuleForUser(req.tenant,req.user,'forex'))
    return res.status(403).send('Forex and Treasury access is required');
   const branch=req.operationBranch;
   const funds=await require('../services/mobileMoneyFunds.service').context(req.tenantDb,req.tenant,req.user,branch);
   const eligible=row=>row.state==='active'&&row.reconciliation==='matched'&&row.expectedMinor!=null;
   const wallets=funds.wallets.filter(eligible),drawers=funds.paymentAccounts.filter(row=>row.kind==='cash'&&eligible(row));
   let result=null,error=null;
   if(req.query.walletAccountId||req.query.cashAccountId||req.query.providerAmountMinor||req.query.providerAmount){
    try{result=await require('../services/momoFxPreview.service').preview(req.tenantDb,req.tenant,req.user,branch,req.query);}
    catch(e){error=e.message;}
   }
   res.set('Cache-Control','private, no-store');
   renderTenant(req,res,'mobile-money/fx','Cross-currency Mobile Money',
    'Approved exchange-rate preview using actual wallet and cash balances; no provider transaction is executed.',
    {wallets,drawers,result,error,input:req.query,idempotencyKey:randomUUID(),selectedBranchId:String(branch._id),formatMoneyMinor:require('../services/mobileMoney.service').formatMoneyMinor});
  }catch(e){next(e);}
 });
 router.get('/fx/preview',async(req,res,next)=>{
  try{
   if(!req.operationBranch)return res.status(409).json({error:'Select an operating branch'});
   res.set('Cache-Control','private, no-store');
   res.json(await require('../services/momoFxPreview.service').preview(req.tenantDb,req.tenant,req.user,req.operationBranch,req.query));
  }catch(e){res.status(e.status>=400&&e.status<500?e.status:500).set('Cache-Control','private, no-store').json({error:e.status>=400&&e.status<500?e.message:'Unable to preview the transaction'});}
 });
 router.get('/funds/context',async(req,res,next)=>{try{if(!req.operationBranch)return res.status(409).json({error:'An operating branch is required.'});res.set('Cache-Control','private, no-store').json(await require('../services/mobileMoneyFunds.service').context(req.tenantDb,req.tenant,req.user,req.operationBranch));}catch(error){next(error);}});
 router.get('/readiness',async(req,res,next)=>{
  try{
   res.set('Cache-Control','private, no-store');
   if(!['Tenant Owner','Mobile Money Operator','Branch Manager','Reconciliation Officer','Auditor'].includes(req.user.role))
    return res.status(403).json({error:'Operational account readiness is restricted.'});
   if(!req.operationBranch)return res.status(409).json({branchReady:false,error:req.operationBranchError||'Assign an operating branch.'});
   const {models}=require('../treasury/models');
   const accounts=models(req.tenantDb).account;
   const broad=['Tenant Owner','Branch Manager','Reconciliation Officer','Auditor'].includes(req.user.role);
   const query={tenantId:req.tenant._id,branchId:req.operationBranch._id,status:{$ne:'archived'},
    ...(broad?{}:{$or:[{operatorId:req.user.id},{operatorId:null}]})};
   const rows=await accounts.find(query).select('kind network currency status openingBalanceMinor openingApprovedAt reconciliationState').sort({_id:1}).limit(501).lean();
   const totals={cash:0,wallet:0,bank:0,unopened:0,held:0,needsReconciliation:0,ready:0};
   const providers={};
   for(const account of rows.slice(0,500)){
    if(Object.hasOwn(totals,account.kind))totals[account.kind]++;
    if(!account.openingApprovedAt||account.openingBalanceMinor===null)totals.unopened++;
    else if(account.status!=='active')totals.held++;
    else if(account.reconciliationState!=='matched')totals.needsReconciliation++;
    else totals.ready++;
    if(account.kind==='wallet'){
     const key=account.network+' / '+account.currency;
     providers[key]=(providers[key]||0)+1;
    }
   }
   const untracked=await require('../models').mobileTransactionModel(req.tenantDb).exists({
    branchId:req.operationBranch._id,fundingState:{$ne:'book_recorded'}
   });
   const readiness={branchReady:true,scope:broad?'all assigned and shared accounts in operating branch':'own and shared accounts in operating branch',
    accountCounts:totals,providerAccountCounts:providers,untrackedHistoricalOperationsPresent:Boolean(untracked),
    truncated:rows.length>500,
    guidance:!totals.wallet?'Configure a provider wallet for each market and obtain independent opening approval.':
      !totals.cash?'Configure a physical cash account and approve its opening balance.':
      totals.unopened?'Submit opening evidence and obtain independent approval.':
      totals.needsReconciliation?'Review and reconcile mismatched account observations.':
      totals.held?'An account is held. Resolve the hold or account discrepancy before processing.':
      'Account setup exists. Verify book values against actual provider statements and cash counts.'};
   if(req.accepts('html')&&req.query.format!=='json')
    renderTenant(req,res,'mobile-money/readiness','Cash and float readiness','Actual branch account configuration and missing approvals, without exposing customer data.',{readiness});
   else res.json(readiness);
  }catch(e){next(e);}
 });
 router.get('/quote',async(req,res,next)=>{
  try{
   if(!req.operationBranch)return res.status(409).set('Cache-Control','private, no-store').json({error:'Assign an operating branch before quoting commissions.'});
   const {NETWORKS}=require('../pricing/networkTariffs');
   const network=String(req.query.network||''),currency=String(req.query.currency||'');
   const operation=String(req.query.operation||'');
   const amount=String(req.query.amount||'');
   if(!Object.hasOwn(NETWORKS,network)||!['cash_in','cash_out'].includes(operation)||
      !require('../../config/currencies').currencyCodes.includes(currency))
    return res.status(400).set('Cache-Control','private, no-store').json({error:'Choose a supported network, operation and currency.'});
   if(NETWORKS[network].currency&&NETWORKS[network].currency!==currency)
    return res.status(400).set('Cache-Control','private, no-store').json({error:'Currency must match the selected network market.'});
   require('../services/branchCurrency.service').resolve(req.operationBranch,currency);
   const minor=require('../services/mobileMoney.service').toMinor(amount,currency);
   const quotes=await require('../pricing/networkTariffService').transactionEstimates(
    req.tenantDb,req.tenant,req.operationBranch,{network,currency,operation,amountMinor:String(minor)});
   const fmt=require('../services/mobileMoney.service').formatMoneyMinor;
   // A public rate table is useful for estimating, but cannot be silently
   // converted into an approved tenant-agent agreement or posted as income.
   const agentReference=network==='MTN'?
    require('../pricing/networkTariffs').quote(
     require('../pricing/networkTariffs').publicAgentReference(operation),String(minor)):null;
   const networkReference=require('../pricing/customerNetworkFees').quote(network,operation,String(minor));
   const agentCommission=quotes.agentCommissionEstimate?
    {amount:fmt(quotes.agentCommissionEstimate.amountMinor,currency),
     version:quotes.agentCommissionEstimate.version,status:'estimate_only',source:'approved_tenant_sheet'}:
    agentReference?.grossCommissionEstimateMinor!=null?
    {amount:fmt(agentReference.grossCommissionEstimateMinor,currency),
     status:'reference_only',source:'published_reference'}:null;
   const customerNetworkCharge=quotes.customerNetworkFeeEstimate?
    {amount:fmt(quotes.customerNetworkFeeEstimate.amountMinor,currency),
     version:quotes.customerNetworkFeeEstimate.version,status:'estimate_only',source:'approved_tenant_sheet'}:
    networkReference?.customerFeeMinor!=null&&['published_reference','historical_source_unverified'].includes(networkReference.status)?
    {amount:fmt(networkReference.customerFeeMinor,currency),
     status:networkReference.status==='published_reference'?'reference_only':'historical_unverified',
     source:networkReference.status==='published_reference'?'published_reference':'historical_reference'}:null;
   res.set('Cache-Control','private, no-store').json({
    network,currency,operation,agentCommission,customerNetworkCharge,
    note:customerNetworkCharge?.source==='historical_reference'?
      'This provider table contains historical rates. Confirm the current provider fee before relying on this amount; it is reference only and never posted as income.':
     agentCommission?.source==='published_reference'||customerNetworkCharge?.source==='published_reference'?
      'Published provider reference only, not an approved tenant rate or guaranteed agent payout. The tenant owner can authorize these existing rates for branch estimates without entering them again. No additional customer charge, funds or income is posted.':
      'Rates from independently approved tenant schedules are estimates. The provider must separately confirm the actual payout; no customer fee or commission income is posted automatically.'
   });
  }catch(e){next(e);}
 });
 router.get('/onboarding',(req,res,next)=>render(req,res,next,{view:'onboarding',title:'Mobile Money onboarding',subtitle:'Configure real cash, float, fees, commissions, SMS and independent controls.'}));
 router.get('/cash-in',(req,res,next)=>render(req,res,next,{view:'entry',title:'Deposit',subtitle:'Receive customer cash and transfer the same amount of electronic float.',operation:'cash_in'}));
 router.get('/cash-out',(req,res,next)=>render(req,res,next,{view:'entry',title:'Withdrawal',subtitle:'Pay customer cash and receive the same amount of electronic float.',operation:'cash_out'}));
 router.get('/network-activity',(req,res,next)=>render(req,res,next,{view:'network',title:'Network activity',subtitle:'Mobile money records grouped by network with recent activity.'}));
 router.get('/cash-impact',(req,res,next)=>render(req,res,next,{view:'cash-impact',title:'Mobile money cash impact',subtitle:'Deposit, withdrawal, commission, and net drawer movement for mobile money.'}));
 router.get('/report',(req,res,next)=>render(req,res,next,{view:'report',title:'Mobile money report',subtitle:'Dedicated report for mobile money count, volume, network mix, and drawer impact.',report:true}));
 router.get('/report/unified.csv',async(req,res,next)=>{
  try{
   if(!workspace.canExport(req.user))return res.status(403).send('Mobile Money report export permission is required.');
   const service=require('../services/mobileMoneyUnifiedReport.service');
   const funds=req.operationBranch?await require('../services/mobileMoneyFunds.service').context(
    req.tenantDb,req.tenant,req.user,req.operationBranch):null;
   const reportZone=await reportTimeZone.forRequest(req);
   const report=await service.generate(req.tenantDb,req.tenant,req.user,
    require('../services/mobileMoneyMarket.service').withDefaultFilters(req.query,funds?.wallets||[]),reportZone);
   res.set({'Content-Type':'text/csv; charset=utf-8',
    'Content-Disposition':`attachment; filename="mobile-money-unified-${report.window.from}-${report.window.to}.csv"`,
    'Cache-Control':'private, no-store'});
   res.send(service.csv(report));
  }catch(error){next(error);}
 });
 router.get('/report/export.csv',async(req,res,next)=>{
  try{
   const reportZone=await reportTimeZone.forRequest(req);
   const result=await workspace.exportCsv(req.tenantDb,req.user,req.query,reportZone);
   res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="mobile-money-${result.filters.from}-${result.filters.to}.csv"`,'Cache-Control':'private, no-store'});
   res.send(result.csv);
  }catch(error){next(error);}
 });
 return router;
};
