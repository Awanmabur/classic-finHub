'use strict';
const {Router}=require('express');
const {randomUUID}=require('node:crypto');
const requirePermission=require('../../middleware/requirePermission');
const throttle=require('../../platform/services/actionThrottle.service').financial;
const {flash}=require('../../utils/view');
const treasury=require('./service');
const {tenantUserModel}=require('../models');
module.exports=function treasuryRoutes({renderTenant}){
 const router=Router(),wrap=handler=>(req,res,next)=>Promise.resolve(handler(req,res)).catch(next);
 router.use(requirePermission('treasury.view'));
 router.use((req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
 function can(req,permission){return req.user.permissions.includes('*')||req.user.permissions.includes(permission);}
 async function renderList(req,res){
  const snapshot=await treasury.balanceSnapshot(req.tenantDb,req.tenant,req.user,{branchId:req.operationBranch?String(req.operationBranch._id):null,currency:req.query.currency||null});
  const queue=can(req,'treasury.review')?await treasury.reviewQueue(req.tenantDb,req.tenant,req.user):[];
  const operators=can(req,'treasury.manage')&&req.operationBranch?await tenantUserModel(req.tenantDb).find({status:'active',$or:[{branchId:String(req.operationBranch._id)},{_id:req.user.id}]}).select('name role branchId').sort({name:1}).limit(300).lean():[];
  renderTenant(req,res,'treasury/index','Wallets, cash & balances','Review actual evidence against the posted funds book.',{snapshot,queue,operators,canManage:can(req,'treasury.manage'),canObserve:can(req,'treasury.observe'),canReview:can(req,'treasury.review'),kinds:treasury.KINDS,networks:treasury.NETWORKS,format:treasury.format,idempotencyKey:randomUUID()});
 }
 router.get('/',wrap(renderList));
 router.get('/accounts/new',requirePermission('treasury.manage'),wrap(renderList));
 router.get('/review',requirePermission('treasury.review'),wrap(renderList));
 router.post('/accounts',requirePermission('treasury.manage'),throttle,wrap(async(req,res)=>{const account=await treasury.createAccount(req.tenantDb,req.tenant,req.user,req.body);flash(req,'good','Funds account created. Submit actual opening evidence and obtain independent review before use.');res.redirect(303,`/tenant/treasury/accounts/${account._id}`);}));
 router.get('/accounts/:id',wrap(async(req,res)=>{const detail=await treasury.accountDetail(req.tenantDb,req.tenant,req.user,req.params.id);renderTenant(req,res,'treasury/detail',detail.account.name,'Expected book balance and independently reviewed actual observations.',{...detail,canObserve:can(req,'treasury.observe'),canReview:can(req,'treasury.review'),idempotencyKey:randomUUID()});}));
 router.post('/accounts/:id/observations',requirePermission('treasury.observe'),throttle,wrap(async(req,res)=>{
  const input={...req.body};if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.observedAt||''))input.observedAt+=':00.000Z';
  await treasury.requestObservation(req.tenantDb,req.tenant,req.user,req.params.id,input);flash(req,'good','Dated actual balance evidence saved for independent review. The expected book was not overwritten.');res.redirect(303,`/tenant/treasury/accounts/${req.params.id}`);
 }));
 router.post('/observations/:id/review',requirePermission('treasury.review'),throttle,wrap(async(req,res)=>{const observation=await treasury.reviewObservation(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good',observation.status==='approved'?'Evidence independently reviewed. Any difference remains visible until resolved.':'Evidence rejected with an audit entry.');res.redirect(303,`/tenant/treasury/accounts/${observation.accountId}`);}));
 router.post('/observations/:id/adjustments',requirePermission('treasury.observe'),throttle,wrap(async(req,res)=>{const result=await treasury.requestAdjustment(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good','Explicit reconciliation adjustment requested. A different authorized reviewer must decide.');res.redirect(303,`/tenant/treasury/accounts/${result.adjustment.accountId}`);}));
 router.post('/adjustments/:id/review',requirePermission('treasury.review'),throttle,wrap(async(req,res)=>{const result=await treasury.reviewAdjustment(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good','Reconciliation adjustment decision saved with its balanced journal and audit history.');res.redirect(303,`/tenant/treasury/accounts/${result.accountId}`);}));
 return router;
};
