'use strict';
const {Router}=require('express');
const {randomUUID}=require('node:crypto');
const requirePermission=require('../../middleware/requirePermission');
const throttle=require('../../platform/services/actionThrottle.service').financial;
const {flash}=require('../../utils/view');
const treasury=require('./service');
const funding=require('./funding.service');
const branchView=require('../services/branchView.service');
const {tenantUserModel}=require('../models');
module.exports=function treasuryRoutes({renderTenant}){
 const router=Router(),wrap=handler=>(req,res,next)=>Promise.resolve(handler(req,res)).catch(next);
 router.use(requirePermission('treasury.view'));
 router.use((req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
 function can(req,permission){return req.user.permissions.includes('*')||req.user.permissions.includes(permission);}
 async function renderList(req,res){
  const branchId=branchView.canViewBranches(req.user)?(req.viewBranchId==='all'?null:req.viewBranchId):req.operationBranch?String(req.operationBranch._id):null;
  const snapshot=await treasury.balanceSnapshot(req.tenantDb,req.tenant,req.user,{branchId,currency:req.query.currency||null});
  const queue=can(req,'treasury.review')?await treasury.reviewQueue(req.tenantDb,req.tenant,req.user):[];
  const setupBranch=branchView.canViewBranches(req.user)?req.viewBranch:req.operationBranch;
  const operatorScope=setupBranch?[{branchId:String(setupBranch._id)},...(String(req.operationBranch?._id||'')===String(setupBranch._id)?[{_id:req.user.id}]:[])]:[];
  const operators=can(req,'treasury.manage')&&setupBranch?await tenantUserModel(req.tenantDb).find({status:'active',$or:operatorScope}).select('name role branchId').sort({name:1}).limit(300).lean():[];
  const fundings=await funding.list(req.tenantDb,req.tenant,req.user);
  const fundingAccounts=can(req,'treasury.observe')?(await treasury.findOperatingAccounts(req.tenantDb,req.tenant,req.user,{branchId})).filter(account=>['cash','bank','wallet'].includes(account.kind)&&account.status==='active'&&account.openingBalanceMinor!==null&&account.reconciliationState==='matched'):[];
  const kinds=treasury.KINDS.filter(kind=>kind==='wallet'?hasSource(req,'mobile_money'):kind==='forex_stock'?hasSource(req,'forex'):kind==='transfer_clearing'?hasSource(req,'money_transfer'):true);
  renderTenant(req,res,'treasury/index','Wallets, cash & balances','Set up accounts, transfer funds and review actual balances.',{snapshot,queue,operators,setupBranch,allBranches:req.viewBranchId==='all',branchNames:Object.fromEntries((res.locals.viewBranches||[]).map(branch=>[String(branch._id),branch.name])),canCreateAccount:can(req,'treasury.manage')&&Boolean(setupBranch),fundings,fundingAccounts,fundingDestination:String(req.query.to||''),canManage:can(req,'treasury.manage'),canObserve:can(req,'treasury.observe'),canReview:can(req,'treasury.review'),kinds,networks:treasury.NETWORKS,format:treasury.format,idempotencyKey:randomUUID(),fundingIdempotencyKey:randomUUID()});
 }
 function hasSource(req,key){return require('../services/moduleAccess.service').hasModuleForUser(req.tenant,req.user,key);}
 router.get('/',wrap(renderList));
 router.get('/accounts/new',requirePermission('treasury.manage'),wrap(renderList));
 router.get('/review',requirePermission('treasury.review'),wrap(renderList));
 router.post('/accounts',requirePermission('treasury.manage'),throttle,wrap(async(req,res)=>{
  if(branchView.canViewBranches(req.user)&&!req.viewBranch)throw treasury.fail('Choose a branch before adding an account',409);
  const account=await treasury.createAccount(req.tenantDb,req.tenant,req.user,req.body,{configurationBranchId:req.viewBranch?String(req.viewBranch._id):null});flash(req,'good','Funds account created. Submit actual opening evidence and obtain independent review before use.');branchView.followRecord(req,account);res.redirect(303,`/tenant/treasury/accounts/${account._id}`);
 }));
 router.post('/funding',requirePermission('treasury.observe'),throttle,wrap(async(req,res)=>{const result=await funding.request(req.tenantDb,req.tenant,req.user,req.body);flash(req,'good',result.duplicate?'This funding transfer already exists.':'Funding transfer submitted for independent review.');branchView.followRecord(req,result.funding);res.redirect(303,'/tenant/treasury#funding-history');}));
 router.post('/funding/:id/review',requirePermission('treasury.review'),throttle,wrap(async(req,res)=>{const result=await funding.review(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good',result.funding.status==='posted'?'Funding posted to both accounts.':'Funding transfer rejected.');branchView.followRecord(req,result.funding);res.redirect(303,'/tenant/treasury#funding-history');}));
 router.get('/accounts/:id',wrap(async(req,res)=>{const detail=await treasury.accountDetail(req.tenantDb,req.tenant,req.user,req.params.id);renderTenant(req,res,'treasury/detail',detail.account.name,'Expected book balance and independently reviewed actual observations.',{...detail,canManage:can(req,'treasury.manage'),canObserve:can(req,'treasury.observe'),canReview:can(req,'treasury.review'),idempotencyKey:randomUUID()});}));
 router.post('/accounts/:id/settings',requirePermission('treasury.manage'),throttle,wrap(async(req,res)=>{const account=await treasury.configureAccount(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good','Account defaults saved for future transactions.');branchView.followRecord(req,account);res.redirect(303,`/tenant/treasury/accounts/${req.params.id}`);}));
 router.post('/accounts/:id/observations',requirePermission('treasury.observe'),throttle,wrap(async(req,res)=>{
  const input={...req.body};if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.observedAt||''))input.observedAt+=':00.000Z';
  const result=await treasury.requestObservation(req.tenantDb,req.tenant,req.user,req.params.id,input);flash(req,'good','Dated actual balance evidence saved for independent review. The expected book was not overwritten.');branchView.followRecord(req,result.observation);res.redirect(303,`/tenant/treasury/accounts/${req.params.id}`);
 }));
 router.post('/observations/:id/review',requirePermission('treasury.review'),throttle,wrap(async(req,res)=>{const observation=await treasury.reviewObservation(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good',observation.status==='approved'?'Evidence independently reviewed. Any difference remains visible until resolved.':'Evidence rejected with an audit entry.');branchView.followRecord(req,observation);res.redirect(303,`/tenant/treasury/accounts/${observation.accountId}`);}));
 router.post('/observations/:id/adjustments',requirePermission('treasury.observe'),throttle,wrap(async(req,res)=>{const result=await treasury.requestAdjustment(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good','Explicit reconciliation adjustment requested. A different authorized reviewer must decide.');branchView.followRecord(req,result.adjustment);res.redirect(303,`/tenant/treasury/accounts/${result.adjustment.accountId}`);}));
 router.post('/adjustments/:id/review',requirePermission('treasury.review'),throttle,wrap(async(req,res)=>{const result=await treasury.reviewAdjustment(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good','Reconciliation adjustment decision saved with its balanced journal and audit history.');branchView.followRecord(req,result);res.redirect(303,`/tenant/treasury/accounts/${result.accountId}`);}));
 return router;
};
