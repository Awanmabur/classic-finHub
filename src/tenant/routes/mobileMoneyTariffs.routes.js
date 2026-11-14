'use strict';
const {Router}=require('express');
const requireModule=require('../../middleware/requireModule');
const requirePermission=require('../../middleware/requirePermission');
const branchService=require('../services/branch.service');
const {flash}=require('../../utils/view');
const throttle=require('../../platform/services/actionThrottle.service').financial;
const service=require('../pricing/networkTariffService');
const payouts=require('../pricing/commissionPayoutService');
const {NETWORKS}=require('../pricing/networkTariffs');
module.exports=function factory({renderTenant}){
 const router=Router();
 router.use(requireModule('mobile_money'),requirePermission('mobile_money.view'));
 router.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
 router.get('/',async(req,res,next)=>{
  try{
   const [schedules,branches,commissions]=await Promise.all([
    service.read(req.tenantDb,req.tenant,req.user),branchService.list(req.tenant),
    payouts.list(req.tenantDb,req.tenant,req.user)
   ]);
   renderTenant(req,res,'mobile-money/tariffs','Network commission sheets',
    'Network agent rates, independent review and non-posting commission quotes.',
    {schedules,commissions,branches:branches.filter(b=>b.status==='active'),
     providerChoices:Object.entries(NETWORKS).filter(([,v])=>Boolean(v.currency)).map(([key,meta])=>({key,...meta})),
     canPropose:req.user.role==='Tenant Owner',
     canReview:req.user.role==='Reconciliation Officer',
     canSubmitPayout:['Tenant Owner','Mobile Money Operator'].includes(req.user.role),
     canReviewPayout:['Tenant Owner','Reconciliation Officer'].includes(req.user.role),
     postingEnabled:process.env.ENABLE_MOMO_COMMISSION_POSTING==='true',
     serializeLines:service.serializeLines});
  }catch(e){next(e);}
 });
 router.post('/',throttle,async(req,res,next)=>{
  try{
   await service.propose(req.tenantDb,req.tenant,req.user,req.body);
   flash(req,'good','Commission sheet submitted for independent review. No funds or income were posted.');
   res.redirect(303,'/tenant/mobile-money/tariffs');
  }catch(e){next(e);}
 });
 router.post('/payouts',requirePermission('treasury.observe'),throttle,async(req,res,next)=>{
  try{
   await payouts.propose(req.tenantDb,req.tenant,req.user,req.body);
   flash(req,'good','Provider commission evidence submitted for independent review. Funds have not changed.');
   res.redirect(303,'/tenant/mobile-money/tariffs');
  }catch(e){next(e);}
 });
 router.post('/payouts/:id/review',requirePermission('treasury.review'),throttle,async(req,res,next)=>{
  try{
   const result=await payouts.review(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good',result.status==='posted'?'Commission receipt posted to the reconciled wallet and income ledger.':'Commission evidence rejected; no funds changed.');
   res.redirect(303,'/tenant/mobile-money/tariffs');
  }catch(e){next(e);}
 });
 router.post('/:id/edit',throttle,async(req,res,next)=>{
  try{
   await service.revise(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good','Draft commission sheet updated. Independent approval is still required.');
   res.redirect(303,'/tenant/mobile-money/tariffs');
  }catch(e){next(e);}
 });
 router.post('/:id/quote',throttle,async(req,res,next)=>{
  try{
   const rows=await service.read(req.tenantDb,req.tenant,req.user);
   const schedule=rows.find(r=>String(r._id)===req.params.id);
   if(!schedule)return res.status(404).type('text/plain').send('Schedule not found');
   const quote=service.preview(schedule,String(req.body.amountMinor||''));
   res.status(200).type('text/plain').send(quote.status==='no_matching_band'?
    'No matching tariff band. No commission calculated.':
    'Expected agent commission: '+schedule.currency+' '+quote.grossCommissionEstimateMinor+
     ' (minor units). Reference only; not earned or received income. No ledger entry was created.');
  }catch(e){next(e);}
 });
 router.post('/:id/:action',throttle,async(req,res,next)=>{
  try{
   await service.decide(req.tenantDb,req.tenant,req.user,req.params.id,req.params.action);
   flash(req,'good','Commission schedule decision recorded and audited. No funds or income were posted.');
   res.redirect(303,'/tenant/mobile-money/tariffs');
  }catch(e){next(e);}
 });

 return router;
};
