'use strict';
// All banking endpoints are operational requests. No bank payment/ledger posting.
const routerFactory=require('express').Router;
const crypto=require('node:crypto');
const requirePermission=require('../../middleware/requirePermission');
const financial=require('../../platform/services/actionThrottle.service').financial;
const bank=require('../services/banking.service');
const branchService=require('../services/branch.service');
const {hasPermission}=require('../services/moduleAccess.service');
const {flash}=require('../../utils/view');
const {bankReferenceModel}=require('../models');
const {formatMoneyMinor}=require('../services/mobileMoney.service');
const {bankInstitutionOptions,resolveBankInstitution}=require('../../utils/selectionOptions');
function routes({renderTenant}){
 const router=routerFactory();
 async function available(req){return (await branchService.list(req.tenant)).filter(b=>b.status==='active'&&
  (req.user.role==='Tenant Owner'||String(b._id)===String(req.user.branchId)));}
 router.get('/',requirePermission('banking.view'),async(req,res,next)=>{
  try{
   const [records,branches,queue]=await Promise.all([
    bank.list(req.tenantDb,req.tenant,req.user),available(req),
    bank.reviewer(req.user)&&hasPermission(req.user,'banking.review')?bank.reviewQueue(req.tenantDb,req.tenant,req.user):[]
   ]);
   const selectedId=String(req.operatingBranchId||'');
   const branch=branches.find(b=>String(b._id)===selectedId);
   const references=branch?await bank.listReferences(req.tenantDb,req.tenant,req.user,{branchId:selectedId}):[];
   renderTenant(req,res,'banking/index','Banking Requests','Controlled bank-operation requests. No real balance, deposit, withdrawal, transfer or bank settlement is represented.',{
    records,branches,queue,references,selectedBranchId:branch?selectedId:null,
    canCreate:bank.operator(req.user)&&hasPermission(req.user,'banking.requests.create'),
    canReview:bank.reviewer(req.user)&&hasPermission(req.user,'banking.review'),
    idempotencyKey:crypto.randomUUID(),formatMoneyMinor
   });
  }catch(e){next(e);}
 });
 router.get('/accounts',requirePermission('banking.view'),async(req,res,next)=>{
  try{const branches=await available(req);
   const selectedId=String(req.operatingBranchId||'');
   const selected=branches.find(b=>String(b._id)===selectedId);
   const references=selected?await bank.listReferences(req.tenantDb,req.tenant,req.user,{branchId:selectedId}):[];
   renderTenant(req,res,'banking/accounts','Bank Account References','Only masked account references; no bank balances or credentials are stored.',{
    branches,selectedBranchId:selected?selectedId:null,references,institutions:bankInstitutionOptions(references),
    canManage:bank.operator(req.user)&&hasPermission(req.user,'banking.accounts.manage')
   });
  }catch(e){next(e);}
 });
 router.post('/accounts',requirePermission('banking.accounts.manage'),financial,async(req,res,next)=>{
  try{const branchId=bank.branchFor(req.user,req.body);
   const known=bankInstitutionOptions(await bank.listReferences(req.tenantDb,req.tenant,req.user,{branchId}));
   const input=resolveBankInstitution(req.body,known);
   await bank.createReference(req.tenantDb,req.tenant,req.user,input);
   flash(req,'good','Masked bank reference saved. This does not open or verify a bank account.');res.redirect(303,'/tenant/banking/accounts');
  }catch(e){next(e);}
 });
 router.get('/accounts/:id/edit',requirePermission('banking.accounts.manage'),async(req,res,next)=>{
  try{if(!bank.operator(req.user))throw bank.fail('Account reference administration forbidden',403);
   const reference=await bankReferenceModel(req.tenantDb).findOne({_id:bank.id(req.params.id),status:'active',...bank.branchScope(req.user)}).lean();
   if(!reference)throw bank.fail('Bank reference not found',404);
   const known=bankInstitutionOptions([{institutionName:reference.institutionName},...await bank.listReferences(req.tenantDb,req.tenant,req.user,{branchId:String(reference.branchId)})]);
   renderTenant(req,res,'banking/account-edit','Edit Bank Reference','Historical banking requests keep their original account snapshots.',{reference,institutions:known});
  }catch(e){next(e);}
 });
 router.post('/accounts/:id/update',requirePermission('banking.accounts.manage'),financial,async(req,res,next)=>{
  try{const reference=await bankReferenceModel(req.tenantDb).findOne({_id:bank.id(req.params.id),status:'active',...bank.branchScope(req.user)}).lean();
   if(!reference)throw bank.fail('Bank reference not found',404);
   const known=bankInstitutionOptions(await bank.listReferences(req.tenantDb,req.tenant,req.user,{branchId:String(reference.branchId)}));
   const input=resolveBankInstitution(req.body,known);
   await bank.updateReference(req.tenantDb,req.tenant,req.user,req.params.id,input);
   flash(req,'good','Reference updated for future requests only.');res.redirect(303,'/tenant/banking/accounts');
  }catch(e){next(e);}
 });
 router.post('/accounts/:id/archive',requirePermission('banking.accounts.manage'),financial,async(req,res,next)=>{
  try{await bank.archiveReference(req.tenantDb,req.tenant,req.user,req.params.id);
   flash(req,'good','Reference archived. Historical requests remain intact.');res.redirect(303,'/tenant/banking/accounts');
  }catch(e){next(e);}
 });
 router.post('/requests',requirePermission('banking.requests.create'),financial,async(req,res,next)=>{
  try{const {order,duplicate}=await bank.createRequest(req.tenantDb,req.tenant,req.user,req.body);
   flash(req,'good',duplicate?'Existing identical request returned; nothing duplicated.':'Banking request recorded, NOT executed or settled.');
   res.redirect(303,`/tenant/banking/${order._id}`);
  }catch(e){next(e);}
 });
 router.get('/history',requirePermission('banking.view'),async(req,res,next)=>{
  try{const records=await bank.list(req.tenantDb,req.tenant,req.user,{cursor:req.query.cursor||null,status:req.query.status||null});
   renderTenant(req,res,'banking/history','Banking Request History','Request states and independent decisions, not a bank statement.',{
    records,status:req.query.status||'',formatMoneyMinor
   });
  }catch(e){next(e);}
 });
 router.get('/:id',requirePermission('banking.view'),async(req,res,next)=>{
  try{const request=await bank.detail(req.tenantDb,req.tenant,req.user,req.params.id);
   renderTenant(req,res,'banking/detail','Banking Request Details','No bank execution or settlement has been claimed.',{
    request,formatMoneyMinor,
    canReview:request.status==='requested'&&new Date(request.expiresAt)>new Date()&&bank.reviewer(req.user)&&hasPermission(req.user,'banking.review')&&String(request.createdBy)!==String(req.user.id),
    canCancel:request.status==='requested'&&(req.user.role==='Tenant Owner'||String(request.createdBy)===String(req.user.id))
   });
  }catch(e){next(e);}
 });
 router.post('/:id/review',requirePermission('banking.review'),financial,async(req,res,next)=>{
  try{await bank.decide(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good','Independent internal decision recorded. No bank payment was made.');
   res.redirect(303,`/tenant/banking/${req.params.id}`);
  }catch(e){next(e);}
 });
 router.post('/:id/cancel',requirePermission('banking.view'),financial,async(req,res,next)=>{
  try{await bank.cancel(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   flash(req,'good','Undecided request cancelled and audited.');res.redirect(303,`/tenant/banking/${req.params.id}`);
  }catch(e){next(e);}
 });
 return router;
}
module.exports=routes;
