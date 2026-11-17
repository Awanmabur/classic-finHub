'use strict';
// Transfer instructions are collected and paid out through independently reviewed manual movements.
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
   renderTenant(req,res,'money-transfer/index','Money Transfer','Transfer instructions, reviewed manual collections and secure PIN payouts.',{
    financeOverview:await require('../services/financeOverview.service').moduleOverview(req.tenantDb,req.tenant,req.user,req.operationBranch),
     currencyChoices:require('../services/branchCurrency.service').options(req.operationBranch),selectedCurrency:req.operationBranch?require('../services/branchCurrency.service').resolve(req.operationBranch,req.query.currency):null,
    records,queue,destinationBranches:(await branchService.list(req.tenant)).filter(branch=>branch.status==='active'&&String(branch._id)!==branchId),branches:availableBranches,selectedBranchId:selected?branchId:null,countryOptions:require('../../utils/selectionOptions').countryOptions(),
    canCreate:writeRoles.has(req.user.role)&&hasPermission(req.user,'money_transfer.create'),
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
   flash(req,'good',duplicate?'This exact request already exists; nothing was duplicated.':'Transfer request recorded. No money has been sent or collected.');
   require('../services/branchView.service').followRecord(req,order);
   res.redirect(303,`/tenant/money-transfer/${order._id}/acknowledgement`);
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
   renderTenant(req,res,'money-transfer/detail','Transfer Request Details',
    'Transfer instructions and independently reviewed manual collections and payouts.',{
     order,formatMoneyMinor,
    pendingMovementId:pendingMovement&&(req.user.role!=='Money Transfer Operator'||String(pendingMovement.createdBy)===String(req.user.id))?pendingMovement._id:null,
     canRecordManual:!pendingMovement&&writeRoles.has(req.user.role)&&hasPermission(req.user,'money_transfer.create')&&hasPermission(req.user,'treasury.view')&&
      (req.user.role==='Tenant Owner'||String(order.createdBy)===String(req.user.id))&&String(req.operationBranch?._id||'')===String(order.branchId)&&
      ['requested','approved_pending_provider'].includes(order.status)&&new Date(order.expiresAt)>new Date(),
     canPayout:order.status==='collected_manual'&&hasPermission(req.user,'money_transfer.payout'),
     canCancel:order.status==='requested'&&(req.user.role==='Tenant Owner'||String(order.createdBy)===String(req.user.id)),
     canReview:order.status==='requested'&&new Date(order.expiresAt)>new Date()&&
      reviewerRoles.has(req.user.role)&&hasPermission(req.user,'money_transfer.review')&&String(order.createdBy)!==String(req.user.id)
    });
  }catch(e){next(e);}
 });
 router.get('/:id/interbranch-cash',requirePermission('money_transfer.view'),async(req,res,next)=>{
  try{
   const finance=require('../settlements/interbranchCash.service');
   const order=await transfer.detail(req.tenantDb,req.tenant,req.user,req.params.id);
   const reimbursements=await finance.detail(req.tenantDb,req.tenant,req.user,order._id);
   const enabled=process.env.CLASSICFIN_INTERBRANCH_CASH_SETTLEMENT==='enabled'&&
    process.env.NODE_ENV!=='production';
   const differentBranches=Boolean(order.destinationBranchId)&&
    String(order.branchId)!==String(order.destinationBranchId);
   const crossCurrency=Boolean(order.payoutCurrency&&order.payoutCurrency!==order.currency);
   const canRequest=enabled&&differentBranches&&!crossCurrency&&
    order.status==='paid_out_manual'&&req.user.role==='Money Transfer Operator'&&
    String(order.createdBy)===String(req.user.id)&&
    String(order.branchId)===String(req.user.branchId)&&
    hasPermission(req.user,'treasury.observe')&&
    !reimbursements.some(x=>['pending_review','posted'].includes(x.status));
   const payout=order.manualPayoutExecutionId?
    await require('../funded/models').models(req.tenantDb).execution
     .findById(order.manualPayoutExecutionId).select('createdBy branchId').lean():null;
   const canConfirm=enabled&&differentBranches&&!crossCurrency&&
    order.status==='paid_out_manual'&&req.user.role==='Money Transfer Operator'&&
    hasPermission(req.user,'money_transfer.payout')&&
    String(req.user.id)===String(payout?.createdBy||'')&&
    String(req.user.branchId)===String(order.destinationBranchId||'');
   const canReview=enabled&&differentBranches&&!crossCurrency&&
    req.user.role==='Tenant Owner'&&
    hasPermission(req.user,'money_transfer.review')&&hasPermission(req.user,'treasury.review');
   renderTenant(req,res,'money-transfer/interbranch-cash','Branch cash reimbursement',
    'Original-currency cash custody, independently reviewed branch reimbursement and retained evidence.',{
     order,enabled,crossCurrency,canRequest,canConfirm,canReview,reimbursements,
     idempotencyKey:crypto.randomUUID(),formatMoneyMinor
    });
  }catch(error){next(error);}
 });
 router.post('/:id/interbranch-cash/request',requirePermission('money_transfer.view'),financial,async(req,res,next)=>{
  try{
   await require('../settlements/interbranchCash.service').request(
    req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good','Cash handover request recorded. No Treasury balances changed; independent receiving-branch proof and owner review are required.');
   res.redirect(303,`/tenant/money-transfer/${req.params.id}/interbranch-cash`);
  }catch(error){next(error);}
 });
 router.post('/:id/interbranch-cash/:settlementId/receive',requirePermission('money_transfer.payout'),financial,async(req,res,next)=>{
  try{
   await require('../settlements/interbranchCash.service').confirmReceipt(
    req.tenantDb,req.tenant,req.user,req.params.settlementId,req.body,req.params.id);
   flash(req,'good','Actual receiving cashier receipt saved. No funds have moved in Treasury yet; owner approval is required.');
   res.redirect(303,`/tenant/money-transfer/${req.params.id}/interbranch-cash`);
  }catch(error){next(error);}
 });
 router.post('/:id/interbranch-cash/:settlementId/review',requirePermission('money_transfer.review'),financial,async(req,res,next)=>{
  try{
   const result=await require('../settlements/interbranchCash.service').review(
    req.tenantDb,req.tenant,req.user,req.params.settlementId,req.body,req.params.id);
   flash(req,'good',result.reimbursement.status==='posted'?
    'Both original-currency cash custody movements and interbranch dues posted to Treasury in one transaction.':
    'Reimbursement rejected; neither branch cash account was changed.');
   res.redirect(303,`/tenant/money-transfer/${req.params.id}/interbranch-cash`);
  }catch(error){next(error);}
 });
 router.get('/:id/refund',requirePermission('money_transfer.view'),async(req,res,next)=>{
  try{
   const refunds=require('../refunds/service');
   const order=await transfer.detail(req.tenantDb,req.tenant,req.user,req.params.id);
   const enabled=process.env.CLASSICFIN_LINKED_CURRENCY_REFUNDS==='enabled';
   const records=await refunds.detail(req.tenantDb,req.tenant,req.user,order._id);
   const isOrigin=String(order.branchId)===String(req.user.branchId||'');
   const canRequest=enabled&&order.status==='collected_manual'&&
    (order.capture?.method||'Cash')==='Cash'&&
    String(order.createdBy)===String(req.user.id)&&
    hasPermission(req.user,'money_transfer.create')&&
    (req.user.role==='Tenant Owner'||isOrigin)&&
    !records.some(row=>['pending_review','posted_refund'].includes(row.status));
   const canReview=enabled&&['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(req.user.role)&&
    hasPermission(req.user,'money_transfer.review')&&hasPermission(req.user,'treasury.review')&&
    (req.user.role==='Tenant Owner'||isOrigin);
   renderTenant(req,res,'money-transfer/refund','Sender cash refund',
    'Original cash collection, independent review and compensation evidence.',{
     order,refunds:records,enabled,canRequest,canReview,
     idempotencyKey:require('node:crypto').randomUUID(),formatMoneyMinor
    });
  }catch(error){next(error);}
 });
 router.post('/:id/refund/request',requirePermission('money_transfer.create'),financial,async(req,res,next)=>{
  try{
   await require('../refunds/service').request(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good','Cash refund requested. No funds have been moved; independent review is required.');
   res.redirect(303,`/tenant/money-transfer/${req.params.id}/refund`);
  }catch(error){next(error);}
 });
 router.post('/:id/refund/:refundId/review',requirePermission('money_transfer.review'),financial,async(req,res,next)=>{
  try{
   const result=await require('../refunds/service').review(
    req.tenantDb,req.tenant,req.user,req.params.refundId,req.body,req.params.id);
   flash(req,'good',result.refund.status==='posted_refund'?
    'Reviewed original-currency cash refund posted and recipient PIN closed.':
    'Refund request rejected. Collected funds and recipient obligation are unchanged.');
   res.redirect(303,`/tenant/money-transfer/${req.params.id}/refund`);
  }catch(error){next(error);}
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
