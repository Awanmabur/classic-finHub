'use strict';
const crypto=require('node:crypto');
const requireModule=require('../../middleware/requireModule');
const requirePermission=require('../../middleware/requirePermission');
const {hasPermission}=require('../services/moduleAccess.service');
const expenses=require('../services/expenses.service');
const mobile=require('../services/mobileMoney.service');
const {flash}=require('../../utils/view');
module.exports=function expensesRoutes({renderTenant}){
 const router=require('express').Router();
 router.use('/expenses',requireModule('expenses'),requirePermission('expenses.view'));
 const throttle=require('../../platform/services/actionThrottle.service').financial;
 const permissions=actor=>Object.fromEntries(['create','correct','void','review'].map(key=>[key,hasPermission(actor,`expenses.${key}`)]));
 async function page(req,res,next){try{
  const records=await expenses.list(req.tenantDb,req.tenant,req.user,req.query);
  renderTenant(req,res,'expenses/index','Expenses','Daily expenses with vendor, method, reference, and amount.',{
   records,permissions:permissions(req.user),idempotencyKey:crypto.randomUUID(),format:mobile.formatMoneyMinor,openModal:req.path.endsWith('/new'),
   fundChoices:await expenses.fundChoices(req.tenantDb,req.tenant,req.user)});
 }catch(error){next(error);}}
 router.get('/expenses',page);router.get('/expenses/new',requirePermission('expenses.create'),page);
 router.post('/expenses',requirePermission('expenses.create'),throttle,async(req,res,next)=>{try{
  const result=await expenses.create(req.tenantDb,req.tenant,req.user,req.body,{requireFunds:true});
  flash(req,'good',result.duplicate?'Expense already recorded. No duplicate was created.':'Expense submitted for independent review. Pending expenses do not reduce cash.');
  res.redirect(303,`/tenant/expenses/${result.record._id}`);
 }catch(error){next(error);}});
 router.get('/expenses/:id',async(req,res,next)=>{try{
  const record=await expenses.detail(req.tenantDb,req.tenant,req.user,req.params.id),perms=permissions(req.user);
  const independent=String(record.operatorId)!==String(req.user.id)&&String(record.pendingChange?.requestedBy||'')!==String(req.user.id);
  renderTenant(req,res,'expenses/detail','Expense details','Original evidence, independent decisions, and correction history.',{
   record,permissions:perms,format:mobile.formatMoneyMinor,fundChoices:perms.review?await expenses.fundChoices(req.tenantDb,req.tenant,req.user,{expenseId:req.params.id}):[],
   canReview:perms.review&&independent&&record.status==='pending_review'&&!record.pendingChange,
   canDecide:perms.review&&independent&&!!record.pendingChange,canChange:['pending_review','approved'].includes(record.status)&&!record.pendingChange});
 }catch(error){next(error);}});
 for(const [action,permission,execute,message] of [
  ['review','expenses.review',(req)=>expenses.review(req.tenantDb,req.tenant,req.user,req.params.id,req.body),'Expense decision saved and audited.'],
  ['correct','expenses.correct',(req)=>expenses.requestChange(req.tenantDb,req.tenant,req.user,req.params.id,req.body,'correct'),'Correction requested. Current evidence is preserved until independent approval.'],
  ['void','expenses.void',(req)=>expenses.requestChange(req.tenantDb,req.tenant,req.user,req.params.id,req.body,'void'),'Void requested. The expense remains in the audit history.'],
  ['decide-change','expenses.review',(req)=>expenses.decideChange(req.tenantDb,req.tenant,req.user,req.params.id,req.body),'Correction decision saved and audited.']]){
  router.post(`/expenses/:id/${action}`,requirePermission(permission),throttle,async(req,res,next)=>{try{await execute(req);flash(req,'good',message);
   res.redirect(303,`/tenant/expenses/${req.params.id}`);}catch(error){next(error);}});
 }
 return router;
};
