'use strict';
// Internal banking instructions continue directly into final cashier-authorized funds posting.
const routerFactory=require('express').Router;
const crypto=require('node:crypto');
const requirePermission=require('../../middleware/requirePermission');
const financial=require('../../platform/services/actionThrottle.service').financial;
const bank=require('../services/banking.service');
const branchService=require('../services/branch.service');
const {hasPermission,hasModuleForUser}=require('../services/moduleAccess.service');
const {flash}=require('../../utils/view');
const {bankReferenceModel}=require('../models');
const {formatMoneyMinor}=require('../services/mobileMoney.service');
const {bankInstitutionOptions,resolveBankInstitution}=require('../../utils/selectionOptions');
function routes({renderTenant}){
 const router=routerFactory();
 router.use(require('./operationWorkspace.routes')({renderTenant,moduleKey:'banking'}));
 async function available(req){return (await branchService.list(req.tenant)).filter(b=>b.status==='active'&&
  (require('../services/branchView.service').canViewBranches(req.user)||String(b._id)===String(req.user.branchId)));}
 router.get('/',requirePermission('banking.view'),async(req,res,next)=>{
  try{
   const [records,branches,queue]=await Promise.all([
    bank.list(req.tenantDb,req.tenant,req.user),available(req),
    bank.reviewer(req.user)&&hasPermission(req.user,'banking.review')?bank.reviewQueue(req.tenantDb,req.tenant,req.user):[]
   ]);
   const selectedId=String(req.operationBranch?._id || '');
   const branch=branches.find(b=>String(b._id)===selectedId);
   const references=branch?await bank.listReferences(req.tenantDb,req.tenant,require('../services/branchView.service').withoutReadView(req.user),{branchId:selectedId}):[];
   if(branch&&hasModuleForUser(req.tenant,req.user,'accounts')&&hasPermission(req.user,'accounts.view'))references.push(...await require('../customerAccounts/bankingBridge').choices(req.tenantDb,req.tenant,req.user,{branchId:selectedId}));
   renderTenant(req,res,'banking/index','Banking Requests','Complete cashier-confirmed internal movements on the actual funds accounts.',{
    financeOverview:await require('../services/financeOverview.service').moduleOverview(req.tenantDb,req.tenant,req.user,req.operationBranch,{moduleKey:'banking'}),
     records,branches,queue,references,selectedBranchId:branch?selectedId:null,
    currencyChoices:require('../services/branchCurrency.service').options(req.operationBranch),selectedCurrency:req.operationBranch?require('../services/branchCurrency.service').resolve(req.operationBranch,req.query.currency):null,
    canCreate:bank.operator(req.user)&&hasPermission(req.user,'banking.requests.create'),
    canFx:hasModuleForUser(req.tenant,req.user,'forex')&&hasModuleForUser(req.tenant,req.user,'accounts')&&
     hasPermission(req.user,'forex.quotes.create')&&hasPermission(req.user,'banking.requests.create')&&
     hasPermission(req.user,'accounts.view')&&hasPermission(req.user,'treasury.observe'),
    canReview:bank.reviewer(req.user)&&hasPermission(req.user,'banking.review'),
    idempotencyKey:crypto.randomUUID(),formatMoneyMinor
   });
  }catch(e){next(e);}
 });
 router.get('/exchange',requirePermission('banking.view'),async(req,res,next)=>{
  try{
   if(!req.operationBranch)return res.status(409).send('Choose an operating branch');
   const fxBank=require('../services/bankingInternalFx.service');
   const [available,records]=await Promise.all([
    fxBank.options(req.tenantDb,req.tenant,req.user,req.operationBranch,{search:req.query.q||''}),
    fxBank.history(req.tenantDb,req.tenant,req.user,req.operationBranch)
   ]);
   renderTenant(req,res,'banking/fx-exchange','Internal Banking Currency Exchange',
    'Real customer account balances exchange across currencies; no external bank transfer is implied.',
    {...available,records,idempotencyKey:crypto.randomUUID(),formatMoneyMinor,rateDisplay:require('../services/forexRateUnits.service').display});
  }catch(e){next(e);}
 });
 router.post('/exchange/preview',requirePermission('banking.requests.create'),financial,async(req,res,next)=>{
  try{
   if(!req.operationBranch)return res.status(409).send('Choose an operating branch');
   const [rateId,rateVersion,rateDecimal]=String(req.body.rateChoice||'').split(':');
   const review=await require('../services/bankingInternalFx.service').preview(
    req.tenantDb,req.tenant,req.user,req.operationBranch,{...req.body,rateId,rateVersion,rateDecimal});
   renderTenant(req,res,'banking/fx-confirm','Review currency exchange',
    'Confirm the exact source debit and destination credit before posting.',
    {review,formatMoneyMinor,rateDisplay:require('../services/forexRateUnits.service').display});
  }catch(e){next(e);}
 });
 router.post('/exchange',requirePermission('banking.requests.create'),financial,async(req,res,next)=>{
  try{
   if(!req.operationBranch)return res.status(409).send('Choose an operating branch');
   const [rateId,rateVersion,rateDecimal]=String(req.body.rateChoice||'').split(':');
   const result=await require('../services/bankingInternalFx.service').convert(
    req.tenantDb,req.tenant,req.user,req.operationBranch,
    {...req.body,rateId,rateVersion,rateDecimal});
   flash(req,'good',result.duplicate?'The identical internal exchange was already posted.':
    'Internal cross-currency account transfer posted in both native-currency ledgers.');
   res.redirect(303,'/tenant/banking/exchange');
  }catch(e){next(e);}
 });
 router.get('/accounts',requirePermission('banking.view'),async(req,res,next)=>{
  try{const branches=await available(req);
   const selectedId=req.viewBranchId?String(req.viewBranchId):String(req.operationBranch?._id || '');
   const selected=branches.find(b=>String(b._id)===selectedId);
   const references=selected||selectedId==='all'?await bank.listReferences(req.tenantDb,req.tenant,req.user,{branchId:selected?selectedId:null}):[];
   renderTenant(req,res,'banking/accounts','Bank Account References','Only masked account references; no bank balances or credentials are stored.',{
    branches,selectedBranchId:selected?selectedId:null,references,institutions:bankInstitutionOptions(references),
    currencyChoices:require('../services/branchCurrency.service').options(req.operationBranch),selectedCurrency:req.operationBranch?require('../services/branchCurrency.service').resolve(req.operationBranch,req.query.currency):null,
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
   const canPost=order.source?.referenceType==='customer_account'&&
    (order.kind!=='transfer_request'||order.destination?.referenceType==='customer_account')&&
    ['requested','approved_pending_bank'].includes(order.status);
   if(canPost){
    flash(req,'good',duplicate?'Resume the existing transaction; do not repeat the money movement.':'Select the real source account and finalize this internal banking transaction.');
    res.redirect(303,`/tenant/funded/prepare/banking/${order._id}`);
   }else{
    flash(req,'good',duplicate?'Existing transaction found; no duplicate created.':'External bank instructions are recorded only; external payment cannot be claimed completed without verified provider posting.');
    res.redirect(303,`/tenant/banking/${order._id}`);
   }
   // Preserve the assigned operating branch in the owner viewing session.
   // Calling this AFTER the success flash appends the branch-follow evidence
   // rather than overwriting it with the new direct-finalization notice.
   require('../services/branchView.service').followRecord(req,order);
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
   const pendingMovement=await require('../funded/models').models(req.tenantDb).execution.findOne({sourceType:'banking',sourceId:request._id,status:'pending_review'}).select('_id createdBy').lean();
   const afterBalances=await require('../services/recordBalances.service').forRecord(req.tenantDb,req.tenant,req.user,'banking',request);
   renderTenant(req,res,'banking/detail','Banking Request Details','Banking instruction and final cashier-posted ledger movements.',{
    request,afterBalances,formatMoneyMinor,
    canFx:hasModuleForUser(req.tenant,req.user,'forex')&&hasModuleForUser(req.tenant,req.user,'accounts')&&
     hasPermission(req.user,'forex.quotes.create')&&hasPermission(req.user,'banking.requests.create')&&
     String(req.operationBranch?._id||'')===String(request.branchId),
    pendingMovementId:pendingMovement&&(req.user.role!=='Banking Operator'||String(pendingMovement.createdBy)===String(req.user.id))?pendingMovement._id:null,
    canRecordManual:!pendingMovement&&bank.operator(req.user)&&hasPermission(req.user,'banking.requests.create')&&hasPermission(req.user,'treasury.view')&&
     (req.user.role==='Tenant Owner'||String(request.createdBy)===String(req.user.id))&&String(req.operationBranch?._id||'')===String(request.branchId)&&
     ['requested','approved_pending_bank'].includes(request.status)&&new Date(request.expiresAt)>new Date()&&request.source?.referenceType==='customer_account'&&
     (request.kind!=='transfer_request'||request.destination?.referenceType==='customer_account'),
    canReview:request.status==='requested'&&new Date(request.expiresAt)>new Date()&&bank.reviewer(req.user)&&hasPermission(req.user,'banking.review')&&(String(request.createdBy)!==String(req.user.id)||require('../services/reviewPolicy').canSelfReviewRoutine(req.user,request.branchId)),
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
