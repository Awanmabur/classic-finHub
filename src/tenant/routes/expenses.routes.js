'use strict';
const crypto=require('node:crypto');
const requireModule=require('../../middleware/requireModule');
const requirePermission=require('../../middleware/requirePermission');
const {hasPermission}=require('../services/moduleAccess.service');
const expenses=require('../services/expenses.service');
const mobile=require('../services/mobileMoney.service');
const businessTime=require('../../utils/businessTime');
const reportTimeZone=require('../services/reportTimeZone.service');
const {flash}=require('../../utils/view');
const {currencyCodes}=require('../../config/currencies');
function reconcileUrl(record){
 const query=new URLSearchParams();
 if(currencyCodes.includes(record.currency))query.set('currency',record.currency);
 if(typeof record.recordReference==='string'&&record.recordReference.length<=64)query.set('expenseRef',record.recordReference);
 return `/tenant/treasury${query.size?'?'+query:''}#expense-reconciliation`;
}
module.exports=function expensesRoutes({renderTenant}){
 const router=require('express').Router();
 router.use('/expenses',requireModule('expenses'),requirePermission('expenses.view'));
 const throttle=require('../../platform/services/actionThrottle.service').financial;
 const permissions=actor=>Object.fromEntries(['create','correct','void','review'].map(key=>[key,hasPermission(actor,`expenses.${key}`)]));
 async function page(req,res,next){try{
  const records=await expenses.list(req.tenantDb,req.tenant,req.user,req.query);
  renderTenant(req,res,'expenses/index','Expenses','Daily expenses with vendor, method, reference, and amount.',{
   records,permissions:permissions(req.user),idempotencyKey:crypto.randomUUID(),format:mobile.formatMoneyMinor,openModal:req.path.endsWith('/new'),
   currencyChoices:require('../services/branchCurrency.service').options(req.operationBranch),selectedCurrency:req.operationBranch?require('../services/branchCurrency.service').resolve(req.operationBranch,req.query.currency):null,
   fundChoices:await expenses.fundChoices(req.tenantDb,req.tenant,req.user)});
 }catch(error){next(error);}}
 router.get('/expenses',page);router.get('/expenses/new',requirePermission('expenses.create'),page);
 router.post('/expenses',requirePermission('expenses.create'),throttle,async(req,res,next)=>{try{
  const result=await expenses.create(req.tenantDb,req.tenant,req.user,req.body,{requireFunds:true});
  flash(req,'good',result.duplicate?'This expense is already recorded; no duplicate debit was made.':'Expense finalized. The selected source account has been debited exactly once, with a permanent audit record.');
  require('../services/branchView.service').followRecord(req,result.record);
  res.redirect(303,`/tenant/expenses/${result.record._id}`);
 }catch(error){next(error);}});
 router.get('/expenses/report',async(req,res,next)=>{try{
  const timeZone=await reportTimeZone.forRequest(req);
  const filters=require('../services/operationsReports.service').parseFilters(req.query,[{key:'expenses'}],timeZone);
  const scope=expenses.scopeFor(req.user);
  const rows=await expenses.reportRows({conn:req.tenantDb,filters,dateRange:filters.dateRange,scope});
  renderTenant(req,res,'retailFinance/module-report','Expenses summary report',
   'Recorded and posted expenses by payment method, status, currency and business date.',{
    moduleKey:'expenses',label:'Expenses',filters,timeZone,rows,home:'/tenant/expenses',canExport:true
   });
 }catch(error){next(error);}});
 router.get('/expenses/report/export.csv',async(req,res,next)=>{try{
  const timeZone=await reportTimeZone.forRequest(req);
  const filters=require('../services/operationsReports.service').parseFilters(req.query,[{key:'expenses'}],timeZone);
  const scope=expenses.scopeFor(req.user);
  const rows=await expenses.reportRows({conn:req.tenantDb,filters,dateRange:filters.dateRange,scope});
  const csv='\uFEFF'+[['Payment method','Status','Currency','Records','Amount'],
   ...rows.map(row=>[row.activity,row.status,row.currency,row.count,row.volume])]
   .map(row=>row.map(mobile.csvCell).join(',')).join('\r\n')+'\r\n';
  res.set({'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow'});
  res.attachment('classicfin-expenses-summary-'+filters.from+'-'+filters.to+'.csv').type('text/csv').send(csv);
 }catch(error){next(error);}});
 router.get('/expenses/:id',async(req,res,next)=>{try{
  const record=await expenses.detail(req.tenantDb,req.tenant,req.user,req.params.id),perms=permissions(req.user);
  const owner=req.user.role==='Tenant Owner';
  const independent=String(record.operatorId)!==String(req.user.id)&&String(record.pendingChange?.requestedBy||'')!==String(req.user.id);
  renderTenant(req,res,'expenses/detail','Expense details','Original expense and correction history.',{
   record,permissions:perms,format:mobile.formatMoneyMinor,fundChoices:(perms.review||String(record.operatorId)===String(req.user.id))?
    await expenses.fundChoices(req.tenantDb,req.tenant,req.user,{expenseId:req.params.id}):[],
   afterBalances:await require('../services/recordBalances.service').forRecord(req.tenantDb,req.tenant,req.user,'expenses',record),
   reconcileHref:owner&&['pending_review','approved'].includes(record.status)?reconcileUrl(record):null,
   canReview:!owner&&perms.review&&(independent||require('../services/reviewPolicy').canSelfReviewRoutine(req.user,record.branchId))&&record.status==='pending_review'&&!record.pendingChange,
   canDecide:!owner&&perms.review&&independent&&!!record.pendingChange,canChange:!owner&&['pending_review','approved'].includes(record.status)&&!record.pendingChange});
 }catch(error){next(error);}});
 router.post('/expenses/:id/reconcile',requirePermission('expenses.review'),throttle,async(req,res,next)=>{
  try{
   const record=await expenses.ownerResolve(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
   const message=record.status==='voided'?'Expense voided.':record.status==='rejected'?'Unposted expense discarded.':
    req.body.operation==='post'?'Expense recorded.':req.body.operation==='dismiss'?'Expense kept.':'Expense corrected.';
   flash(req,'good',message);
   require('../services/branchView.service').followRecord(req,record);
   res.redirect(303,reconcileUrl(record));
  }catch(error){
   if(req.user.role!=='Tenant Owner'||![400,409].includes(error.status))return next(error);
   flash(req,'bad',error.message);
   res.redirect(303,reconcileUrl({currency:req.body.currency,recordReference:req.body.expenseRef}));
  }
 });
 for(const [action,permission,execute,message] of [
  ['review','expenses.review',(req)=>expenses.review(req.tenantDb,req.tenant,req.user,req.params.id,req.body),'Expense decision saved and audited.'],
  ['correct','expenses.correct',(req)=>expenses.requestChange(req.tenantDb,req.tenant,req.user,req.params.id,req.body,'correct'),'Correction requested. Current evidence is preserved until independent approval.'],
  ['void','expenses.void',(req)=>expenses.requestChange(req.tenantDb,req.tenant,req.user,req.params.id,req.body,'void'),'Void requested. The expense remains in the audit history.'],
  ['decide-change','expenses.review',(req)=>expenses.decideChange(req.tenantDb,req.tenant,req.user,req.params.id,req.body),'Correction decision saved and audited.']]){
  router.post(`/expenses/:id/${action}`,requirePermission(permission),throttle,async(req,res,next)=>{try{
   if(req.user.role==='Tenant Owner'){
    const record=await expenses.detail(req.tenantDb,req.tenant,req.user,req.params.id);
    require('../services/branchView.service').followRecord(req,record);
    return res.redirect(303,reconcileUrl(record));
   }
   const result=await execute(req);flash(req,'good',action==='review'?(result.status==='approved'?'Expense approved. The selected cash, wallet or bank account was deducted automatically once.':'Expense rejected; no account balance was deducted.'):message);
   res.redirect(303,`/tenant/expenses/${req.params.id}`);}catch(error){next(error);}});
 }
 return router;
};
