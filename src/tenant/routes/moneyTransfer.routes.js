'use strict';
// Cashier-confirmed collection posts immediately to the actual source funds, creates a PIN and records the transfer.
// Each endpoint checks the real entitlement and server role.
const newRouter=require('express').Router;
const crypto=require('node:crypto');
const requirePermission=require('../../middleware/requirePermission');
const financial=require('../../platform/services/actionThrottle.service').financial;
const transfer=require('../services/moneyTransfer.service');
const branchService=require('../services/branch.service');
const {flash}=require('../../utils/view');
const {hasPermission}=require('../services/moduleAccess.service');
const {transferContactModel,transferOrderModel}=require('../models');
const {fromMinor}=require('../services/mobileMoney.service');
const {formatMoneyMinor}=require('../services/mobileMoney.service');
const writeRoles=new Set(['Tenant Owner','Money Transfer Operator']);
const reviewerRoles=new Set(['Tenant Owner','Branch Manager','Reconciliation Officer']);
function routes({renderTenant}){
 const router=newRouter();
 router.use(require('./operationWorkspace.routes')({renderTenant,moduleKey:'money_transfer'}));
 async function branches(req){return (await branchService.list(req.tenant)).filter(b=>b.status==='active' &&
   (require('../services/branchView.service').canViewBranches(req.user)||String(b._id)===String(req.user.branchId)));}
 router.get('/',requirePermission('money_transfer.view'),async(req,res,next)=>{
  try{
   const [records,queue,availableBranches]=await Promise.all([
    transfer.list(req.tenantDb,req.tenant,req.user,{}),
    hasPermission(req.user,'money_transfer.review')&&reviewerRoles.has(req.user.role)?transfer.reviewQueue(req.tenantDb,req.tenant,req.user):[],
    branches(req)
   ]);
   const branchId=String(req.operationBranch?._id || '');
   const selected=availableBranches.find(b=>String(b._id)===branchId);
   renderTenant(req,res,'money-transfer/index','Money Transfer','Cashier-confirmed transfers, PIN-backed payouts and audited account balances.',{
    financeOverview:await require('../services/financeOverview.service').moduleOverview(req.tenantDb,req.tenant,req.user,req.operationBranch,{moduleKey:'money_transfer'}),
     currencyChoices:require('../services/branchCurrency.service').options(req.operationBranch),selectedCurrency:req.operationBranch?require('../services/branchCurrency.service').resolve(req.operationBranch,req.query.currency):null,
    records,queue,destinationBranches:(await branchService.list(req.tenant)).filter(branch=>branch.status==='active'&&String(branch._id)!==branchId),branches:availableBranches,selectedBranchId:selected?branchId:null,countryOptions:require('../../utils/selectionOptions').countryOptions(),
    canCreate:writeRoles.has(req.user.role)&&hasPermission(req.user,'money_transfer.create'),
    canFx:require('../services/moduleAccess.service').hasModuleForUser(req.tenant,req.user,'forex')&&hasPermission(req.user,'forex.quotes.create'),
    canReview:reviewerRoles.has(req.user.role)&&hasPermission(req.user,'money_transfer.review'),
    idempotencyKey:crypto.randomUUID(),formatMoneyMinor
   });
  }catch(e){next(e);}
 });
 router.get('/branch-balances',requirePermission('money_transfer.view'),async(req,res,next)=>{try{renderTenant(req,res,'money-transfer/branch-balances','Branch transfer balances','Outstanding dues from independently reviewed branch payouts.',await transfer.branchBalances(req.tenantDb,req.tenant,req.user));}catch(error){next(error);}});
 router.get('/contacts',requirePermission('money_transfer.view'),async(req,res,next)=>{
  try{const available=await branches(req),requested=req.viewBranchId?String(req.viewBranchId):String(req.operationBranch?._id || '');
   const selected=available.find(b=>String(b._id)===requested);
   const contacts=selected||requested==='all'?await transfer.listContacts(req.tenantDb,req.tenant,req.user,{branchId:selected?requested:null}):[];
   renderTenant(req,res,'money-transfer/contacts','Transfer Contacts',
    'Branch-scoped senders and beneficiaries. Contact changes never rewrite historical transfer snapshots.',{
     branches:available,selectedBranchId:selected?requested:null,contacts,countryOptions:require('../../utils/selectionOptions').countryOptions(),canManage:writeRoles.has(req.user.role)&&hasPermission(req.user,'money_transfer.contacts')
    });
  }catch(e){next(e);}
 });
 router.post('/contacts',requirePermission('money_transfer.contacts'),financial,async(req,res,next)=>{
  try{await transfer.addContact(req.tenantDb,req.tenant,req.user,req.body);flash(req,'good','Contact saved. Identity verification has not been performed.');
   res.redirect(303,'/tenant/money-transfer/contacts');
  }catch(e){next(e);}
 });
 router.get('/contacts/:id/edit',requirePermission('money_transfer.contacts'),async(req,res,next)=>{
  try{
   const contact=await transferContactModel(req.tenantDb).findOne({_id:transfer.id(req.params.id),...transfer.branchScope(req.user)}).lean();
   if(!contact)return res.status(404).send('Contact not found');
   renderTenant(req,res,'money-transfer/contact-edit','Edit Transfer Contact',
    'Updates affect future requests only; submitted transfer details remain immutable.',{contact,countryOptions:require('../../utils/selectionOptions').countryOptions()});
  }catch(e){next(e);}
 });
 router.post('/contacts/:id/update',requirePermission('money_transfer.contacts'),financial,async(req,res,next)=>{
  try{await transfer.updateContact(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good','Contact updated for future requests.');res.redirect(303,'/tenant/money-transfer/contacts');
  }catch(e){next(e);}
 });
 router.post('/contacts/:id/archive',requirePermission('money_transfer.contacts'),financial,async(req,res,next)=>{
  try{await transfer.archiveContact(req.tenantDb,req.tenant,req.user,req.params.id);
   flash(req,'good','Contact archived. Previous transfer details are preserved.');res.redirect(303,'/tenant/money-transfer/contacts');
  }catch(e){next(e);}
 });
 router.post('/requests',requirePermission('money_transfer.create'),financial,async(req,res,next)=>{
  try{
   const {order,duplicate}=await transfer.createRequest(req.tenantDb,req.tenant,req.user,req.body);
   if(['requested','approved_pending_provider'].includes(order.status)){
    flash(req,'good',duplicate?'Resume the existing transfer without handing over funds twice.':'Select the collected cash or wallet and finalize the transfer to issue its payout PIN.');
    res.redirect(303,`/tenant/funded/prepare/money_transfer/${order._id}`);
   }else{
    flash(req,'good','This transfer already has a recorded status; no duplicate collection was posted.');
    res.redirect(303,`/tenant/money-transfer/${order._id}`);
   }
   // Preserve the assigned operating branch in the owner viewing session.
   // Calling this AFTER the success flash appends the branch-follow evidence
   // rather than overwriting it with the new direct-finalization notice.
   require('../services/branchView.service').followRecord(req,order);
  }catch(e){next(e);}
 });
 router.get('/history',requirePermission('money_transfer.view'),async(req,res,next)=>{
  try{const records=await transfer.list(req.tenantDb,req.tenant,req.user,{status:req.query.status||null,cursor:req.query.cursor||null});
   renderTenant(req,res,'money-transfer/history','Transfer Request History',
    'Immutable request records and controlled decisions, filtered to your assigned scope.',{records,status:req.query.status||'',formatMoneyMinor});
  }catch(e){next(e);}
 });
 router.get('/:id/acknowledgement',requirePermission('money_transfer.view'),async(req,res,next)=>{
  try{const order=await transfer.detail(req.tenantDb,req.tenant,req.user,req.params.id);
   res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Robots-Tag','noindex, nofollow');
   const businessTime=require('../../utils/businessTime');
   const timeZone=businessTime.forBranch((res.locals.viewBranches||[]).find(b=>String(b._id)===String(order.branchId))||req.operationBranch);
   res.render('tenant/money-transfer/acknowledgement',{order,tenant:req.tenant,user:req.user,flash:require('../../utils/view').consumeFlash(req),identity:req.workspaceIdentity||await require('../workspace/service').receiptIdentity(req.tenantDb,req.tenant),
    businessTimeZone:timeZone,formatLocalDate:value=>businessTime.format(value,timeZone),
    formatMoneyMinor,assetVersion:res.locals.assetVersion});
  }catch(e){next(e);}
 });
 router.get('/:id',requirePermission('money_transfer.view'),async(req,res,next)=>{
  try{const order=await transfer.detail(req.tenantDb,req.tenant,req.user,req.params.id);
   const pendingMovement=await require('../funded/models').models(req.tenantDb).execution.findOne({sourceType:'money_transfer',sourceId:order._id,status:'pending_review'}).select('_id createdBy').lean();
   const afterBalances=await require('../services/recordBalances.service').forRecord(req.tenantDb,req.tenant,req.user,'money_transfer',order);
   renderTenant(req,res,'money-transfer/detail','Transfer Request Details',
    'Recorded transfer collection and PIN-backed payout movements.',{
     order,afterBalances,formatMoneyMinor,
     canFx:order.status==='collected_manual'&&
      require('../services/moduleAccess.service').hasModuleForUser(req.tenant,req.user,'forex')&&
      hasPermission(req.user,'forex.quotes.create')&&
      (req.user.role==='Tenant Owner'||String(req.user.id)===String(order.createdBy))&&
      String(req.operationBranch?._id||'')===String(order.branchId),
    pendingMovementId:pendingMovement&&(req.user.role!=='Money Transfer Operator'||String(pendingMovement.createdBy)===String(req.user.id))?pendingMovement._id:null,
     canRecordManual:!pendingMovement&&writeRoles.has(req.user.role)&&hasPermission(req.user,'money_transfer.create')&&hasPermission(req.user,'treasury.view')&&
      (req.user.role==='Tenant Owner'||String(order.createdBy)===String(req.user.id))&&String(req.operationBranch?._id||'')===String(order.branchId)&&
      ['requested','approved_pending_provider'].includes(order.status)&&new Date(order.expiresAt)>new Date(),
     canPayout:order.status==='collected_manual'&&hasPermission(req.user,'money_transfer.payout'),
     canCancel:order.status==='requested'&&(req.user.role==='Tenant Owner'||String(order.createdBy)===String(req.user.id)),
     canReview:order.status==='requested'&&new Date(order.expiresAt)>new Date()&&
      reviewerRoles.has(req.user.role)&&hasPermission(req.user,'money_transfer.review')&&(String(order.createdBy)!==String(req.user.id)||require('../services/reviewPolicy').canSelfReviewRoutine(req.user,order.branchId))
    });
  }catch(e){next(e);}
 });
 router.post('/:id/review',requirePermission('money_transfer.review'),financial,async(req,res,next)=>{
  try{await transfer.decide(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good','Independent decision saved. Approval does not send or settle funds.');
   res.redirect(303,`/tenant/money-transfer/${req.params.id}`);
  }catch(e){next(e);}
 });
 router.post('/:id/cancel',requirePermission('money_transfer.view'),financial,async(req,res,next)=>{
  try{await transfer.cancel(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good','Pending request cancelled and audited.');res.redirect(303,`/tenant/money-transfer/${req.params.id}`);
  }catch(e){next(e);}
 });
 return router;
}
module.exports=routes;
