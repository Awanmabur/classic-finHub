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
    currencyChoices:require('../services/branchCurrency.service').options(req.operationBranch),selectedCurrency:req.operationBranch?require('../services/branchCurrency.service').resolve(req.operationBranch,req.query.currency):null,
    records,queue,branches:availableBranches,selectedBranchId:selected?branchId:null,countryOptions:require('../../utils/selectionOptions').countryOptions(),
    canCreate:writeRoles.has(req.user.role)&&hasPermission(req.user,'money_transfer.create'),
    canReview:reviewerRoles.has(req.user.role)&&hasPermission(req.user,'money_transfer.review'),
    idempotencyKey:crypto.randomUUID(),formatMoneyMinor
   });
  }catch(e){next(e);}
 });
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
   res.render('tenant/money-transfer/acknowledgement',{order,tenant:req.tenant,user:req.user,identity:req.workspaceIdentity||await require('../workspace/service').receiptIdentity(req.tenantDb,req.tenant),
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
