'use strict';
// Evidence-backed, tenant-scoped, native-currency bullet loans. No loan is
// disbursed unless real Treasury funds are posted in the SAME Mongo transaction.
// Flat contractual interest is collected on receipt, not invented as cash income.
const crypto=require('node:crypto');
const F=require('./security'),{models,ensure}=require('./loans.models');
const treasury=require('../treasury/service');
const core=require('../models');
const {customerModel}=require('../customerAccounts/models');
const {resolve:branchCurrency}=require('../services/branchCurrency.service');
const {reserveUsage}=require('../../platform/services/commercial.service');
const OID=/^[0-9a-f]{24}$/i;
const positive=(n,label)=>{if(n<=0n)throw F.fail(label+' must be greater than zero');return n;};
function int(value,label,min,max){if(!/^\d+$/.test(String(value||''))||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)throw F.fail('Invalid '+label);return Number(value);}
function interest(principal,bps){return (principal*BigInt(bps)+5000n)/10000n;}
function nonempty(value,label){return F.clean(value,label,8,400);}
function summaryRows(records){
 const byCurrency=new Map();
 for(const row of records){
  if(!['active','paid'].includes(row.status))continue;
  const key=row.currency,c=byCurrency.get(key)||{currency:key,principalOutstanding:0n,interestOutstanding:0n,issued:0n,late:0};
  c.issued+=BigInt(String(row.principalMinor));
  c.principalOutstanding+=BigInt(String(row.principalOutstandingMinor));
  c.interestOutstanding+=BigInt(String(row.interestOutstandingMinor));
  if(row.status==='active'&&new Date(row.dueAt)<new Date())c.late++;
  byCurrency.set(key,c);
 }
 return [...byCurrency.values()].map(v=>({...v,issued:String(v.issued),principalOutstanding:String(v.principalOutstanding),interestOutstanding:String(v.interestOutstanding)}));
}
async function createProduct(conn,tenant,actor,input){
 let current=await F.access(conn,tenant,actor,'loans','loans.manage');
 if(!['Tenant Owner','Branch Manager'].includes(current.actor.role))throw F.fail('Loan product policy is managed by the owner or branch manager',403);
 const branch=await F.operatingBranch(conn,current.actor,input),currency=branchCurrency(branch,input.currency);
 const name=F.clean(input.name,'loan product name',3,100),bps=int(input.interestBps,'flat interest rate',0,10000),days=int(input.termDays,'term in days',1,730);
 const min=positive(F.amount(input.minimum,currency),'Minimum principal'),max=positive(F.amount(input.maximum,currency),'Maximum principal');
 if(max<min||max>999999999999999n)throw F.fail('Loan amount range is invalid');
 await ensure(conn);
 return F.transact(conn,async session=>{
  current=await F.access(conn,tenant,actor,'loans','loans.manage',session);
  const active=await F.operatingBranch(conn,current.actor,input,session);
  if(String(active._id)!==String(branch._id))throw F.fail('Branch changed. Reload the form.',409);
  const [product]=await models(conn).product.create([{tenantId:current.tenant._id,branchId:active._id,name,currency,
   flatInterestBps:bps,termDays:days,minMinor:F.d(min),maxMinor:F.d(max),createdBy:F.oid(current.actor.id)}],{session});
  await F.audit(conn,session,current.actor,product._id,'loans.product.created',{branchId:String(active._id),currency,bps,days});
  return product;
 });
}
async function apply(conn,tenant,actor,input){
 let current=await F.access(conn,tenant,actor,'loans','loans.create');
 if(!['Tenant Owner','Branch Manager','Banking Operator'].includes(current.actor.role))throw F.fail('Loan creation is limited to authorized banking staff',403);
 const branch=await F.operatingBranch(conn,current.actor,input),key=F.uuid(input.idempotencyKey),pid=F.oid(input.productId,'loan product');
 const borrower=F.oid(input.customerId,'borrower'),reason=nonempty(input.reason,'loan purpose');
 await ensure(conn);
 const requestHash=F.hash({actorId:String(actor.id),branchId:String(branch._id),productId:String(pid),customerId:String(borrower),principal:String(input.principal),reason});
 const existing=await models(conn).loan.findOne({requestKey:key}).lean();
 if(existing){if(existing.requestHash!==requestHash)throw F.fail('Loan request reference reused with different values',409);return {loan:existing,duplicate:true};}
 return F.transact(conn,async session=>{
  current=await F.access(conn,tenant,actor,'loans','loans.create',session);
  const active=await F.operatingBranch(conn,current.actor,input,session);
  if(String(active._id)!==String(branch._id))throw F.fail('Operating branch changed',409);
  const p=await models(conn).product.findOne({_id:pid,tenantId:current.tenant._id,branchId:active._id,status:'active'}).session(session).lean();
  if(!p)throw F.fail('Loan product is unavailable for your branch',409);
  const customer=await customerModel(conn).findOne({_id:borrower,branchId:active._id,status:'active'}).session(session).lean();
  if(!customer)throw F.fail('Select an active borrower from the customer directory',409);
  const amount=F.amount(input.principal,p.currency),minimum=BigInt(String(p.minMinor)),maximum=BigInt(String(p.maxMinor));
  if(amount<minimum||amount>maximum)throw F.fail('Principal is outside the approved loan product limits',409);
  const dueAt=new Date(Date.now()+p.termDays*86400000);
  const coupon=interest(amount,p.flatInterestBps);
  await reserveUsage(current.tenant,'loan_requests',session);
  const [loan]=await models(conn).loan.create([{tenantId:current.tenant._id,branchId:active._id,customerId:borrower,productId:p._id,
   requestKey:key,requestHash,applicationRef:'LN-'+crypto.randomBytes(9).toString('hex').toUpperCase(),principalMinor:F.d(amount),
   interestMinor:F.d(coupon),principalOutstandingMinor:F.d(0),interestOutstandingMinor:F.d(0),
   currency:p.currency,dueAt,reason,requestedBy:F.oid(current.actor.id)}],{session});
  await F.audit(conn,session,current.actor,loan._id,'loans.application.requested',{branchId:String(active._id),principalMinor:String(amount),currency:p.currency});
  return {loan,duplicate:false};
 });
}
async function review(conn,tenant,actor,loanId,input){
 let current=await F.access(conn,tenant,actor,'loans','loans.review');
 if(!['Tenant Owner','Branch Manager'].includes(current.actor.role))throw F.fail('Owner or manager approval required',403);
 if(!['approve','decline'].includes(input.decision))throw F.fail('Choose approve or decline');
 const note=nonempty(input.reason,'approval justification'),id=F.oid(loanId,'loan');
 await ensure(conn);
 return F.transact(conn,async session=>{
  current=await F.access(conn,tenant,actor,'loans','loans.review',session);
  const old=await models(conn).loan.findOne({_id:id,tenantId:current.tenant._id,status:'requested',...F.scope(current.actor)}).session(session).lean();
  if(!old)throw F.fail('Loan is not pending approval in your permitted branch',409);
  if(String(old.requestedBy)===String(current.actor.id))throw F.fail('A second authorized person must review this loan',409);
  const result=await models(conn).loan.findOneAndUpdate({_id:id,status:'requested',revision:old.revision},{$set:{
   status:input.decision==='approve'?'approved':'declined',reviewedBy:F.oid(current.actor.id),reviewedAt:new Date(),reviewReason:note
  },$inc:{revision:1}},{session,new:true});
  if(!result)throw F.fail('Loan was reviewed concurrently',409);
  await F.audit(conn,session,current.actor,id,'loans.application.'+(input.decision==='approve'?'approved':'declined'),{branchId:String(old.branchId),reason:note});
  return result;
 });
}
async function disburse(conn,tenant,actor,loanId,input){
 const id=F.oid(loanId,'loan'),evidence=F.clean(input.reference,'disbursement evidence reference',6,120),accountId=F.oid(input.accountId,'funding account');
 await Promise.all([ensure(conn),require('../treasury/models').ensure(conn)]);
 return F.transact(conn,async session=>{
  const current=await F.access(conn,tenant,actor,'loans','loans.disburse',session);
  if(!['Tenant Owner','Branch Manager'].includes(current.actor.role))throw F.fail('Loan disbursement requires an owner or branch manager',403);
  const record=await models(conn).loan.findOne({_id:id,tenantId:current.tenant._id,status:'approved',...F.scope(current.actor)}).session(session).lean();
  if(!record)throw F.fail('This loan is not approved for disbursement',409);
  const branch=await F.operatingBranch(conn,current.actor,input,session);
  if(String(branch._id)!==String(record.branchId))throw F.fail('Select the loan issuing branch',409);
  branchCurrency(branch,record.currency);
  const auth=await treasury.access(conn,current.tenant,current.actor,{permission:'treasury.observe',session,fence:true,sourceType:'loans'});
  const fund=await F.funds(conn,auth,accountId,record.branchId,record.currency,session);
  const principal=String(record.principalMinor),receivable=await treasury.ensureCounterAccount(conn,session,{
   tenantId:current.tenant._id,branchId:record.branchId,currency:record.currency,purpose:'loan_receivable',actorId:current.actor.id});
  const posted=await treasury.applyMovements(conn,session,auth,{sourceType:'loans',sourceRef:'LOAN:'+id+':DISBURSE',
   branchId:String(record.branchId),legs:[{accountId:String(fund._id),deltaMinor:'-'+principal}],
   ledgerLines:[{accountId:String(receivable.ledgerAccountId),currency:record.currency,side:'debit',amountMinor:principal}],
   description:'Verified loan disbursement '+record.applicationRef,evidenceRef:evidence});
  const changed=await models(conn).loan.findOneAndUpdate({_id:id,status:'approved',revision:record.revision},{$set:{
   status:'active',dueAt:new Date(Date.now()+(await models(conn).product.findById(record.productId).session(session).lean()).termDays*86400000),sourceAccountId:fund._id,disbursementBatchId:posted.batch._id,disbursementRef:evidence,
   disbursedBy:F.oid(current.actor.id),disbursedAt:new Date(),principalOutstandingMinor:F.d(principal),
   interestOutstandingMinor:F.d(record.interestMinor)
  },$inc:{revision:1}},{session,new:true});
  if(!changed)throw F.fail('Loan state changed during disbursement',409);
  await F.audit(conn,session,current.actor,id,'loans.disbursed',{branchId:String(record.branchId),accountId:String(fund._id),batchId:String(posted.batch._id)});
  return changed;
 });
}
async function repay(conn,tenant,actor,loanId,input){
 const id=F.oid(loanId,'loan'),key=F.uuid(input.idempotencyKey),accountId=F.oid(input.accountId,'receiving account');
 const reference=F.clean(input.reference,'verified repayment evidence',6,120);
 await Promise.all([ensure(conn),require('../treasury/models').ensure(conn)]);
 const oldPayment=await models(conn).payment.findOne({idempotencyKey:key}).lean();
 if(oldPayment){
  const check=F.hash({loanId:String(id),amount:String(input.amount),accountId:String(accountId),reference,actorId:String(actor.id)});
  if(oldPayment.fingerprint!==check)throw F.fail('Repayment reference already used for different values',409);
  return {payment:oldPayment,duplicate:true};
 }
 return F.transact(conn,async session=>{
  const current=await F.access(conn,tenant,actor,'loans','loans.repay',session);
  const record=await models(conn).loan.findOne({_id:id,tenantId:current.tenant._id,status:'active',...F.scope(current.actor)}).session(session).lean();
  if(!record)throw F.fail('Loan is not active or was already paid',409);
  const amount=F.amount(input.amount,record.currency),remainingPrincipal=BigInt(String(record.principalOutstandingMinor)),
   remainingInterest=BigInt(String(record.interestOutstandingMinor));
  if(amount>remainingPrincipal+remainingInterest)throw F.fail('Repayment cannot exceed the outstanding balance',409);
  const interestPart=amount<remainingInterest?amount:remainingInterest,principalPart=amount-interestPart;
  const branch=await F.operatingBranch(conn,current.actor,input,session);
  if(String(branch._id)!==String(record.branchId))throw F.fail('Repayment must be recorded in the issuing branch',409);
  branchCurrency(branch,record.currency);
  const auth=await treasury.access(conn,current.tenant,current.actor,{permission:'treasury.observe',session,fence:true,sourceType:'loans'});
  const fund=await F.funds(conn,auth,accountId,record.branchId,record.currency,session);
  const receivable=principalPart>0n?await treasury.ensureCounterAccount(conn,session,{tenantId:current.tenant._id,branchId:record.branchId,currency:record.currency,purpose:'loan_receivable',actorId:current.actor.id}):null;
  const income=interestPart>0n?await treasury.ensureCounterAccount(conn,session,{tenantId:current.tenant._id,branchId:record.branchId,currency:record.currency,purpose:'loan_interest_income',actorId:current.actor.id}):null;
  const lines=[
   ...(principalPart>0n?[{currency:record.currency,accountId:String(receivable.ledgerAccountId),side:'credit',amountMinor:String(principalPart)}]:[]),
   ...(interestPart>0n?[{currency:record.currency,accountId:String(income.ledgerAccountId),side:'credit',amountMinor:String(interestPart)}]:[])
  ];
  const posted=await treasury.applyMovements(conn,session,auth,{sourceType:'loans',sourceRef:'LOAN:'+id+':PAY:'+key,
   branchId:String(record.branchId),legs:[{accountId:String(fund._id),deltaMinor:String(amount)}],ledgerLines:lines,
   description:'Verified loan repayment '+record.applicationRef,evidenceRef:reference});
  const newPrincipal=remainingPrincipal-principalPart,newInterest=remainingInterest-interestPart;
  const updated=await models(conn).loan.findOneAndUpdate({_id:id,status:'active',revision:record.revision},{$set:{
   principalOutstandingMinor:F.d(newPrincipal),interestOutstandingMinor:F.d(newInterest),
   ...(newPrincipal===0n&&newInterest===0n?{status:'paid'}:{})
  },$inc:{revision:1}},{session,new:true});
  if(!updated)throw F.fail('Loan changed concurrently',409);
  await reserveUsage(current.tenant,'loan_payments',session);
  const fingerprint=F.hash({loanId:String(id),amount:String(input.amount),accountId:String(accountId),reference,actorId:String(actor.id)});
  const [payment]=await models(conn).payment.create([{tenantId:current.tenant._id,branchId:record.branchId,loanId:id,
   idempotencyKey:key,fingerprint,amountMinor:F.d(amount),principalMinor:F.d(principalPart),interestMinor:F.d(interestPart),
   currency:record.currency,accountId:fund._id,reference,batchId:posted.batch._id,createdBy:F.oid(current.actor.id)}],{session});
  await F.audit(conn,session,current.actor,id,'loans.payment.recorded',{branchId:String(record.branchId),amountMinor:String(amount),
   principalMinor:String(principalPart),interestMinor:String(interestPart),batchId:String(posted.batch._id)});
  return {payment,duplicate:false};
 });
}
async function reverseRepayment(conn,tenant,actor,loanId,paymentId,input){
 const id=F.oid(loanId,'loan'),pid=F.oid(paymentId,'repayment');
 const reason=F.clean(input.reason,'correction reason',12,400);
 const reference=F.clean(input.reference,'verified correction evidence reference',6,120);
 await Promise.all([ensure(conn),require('../treasury/models').ensure(conn)]);
 return F.transact(conn,async session=>{
  const current=await F.access(conn,tenant,actor,'loans','loans.review',session);
  if(!['Tenant Owner','Branch Manager'].includes(current.actor.role))
   throw F.fail('Independent owner or manager reversal required',403);
  const record=await models(conn).loan.findOne({_id:id,tenantId:current.tenant._id,status:{$in:['active','paid']},...F.scope(current.actor)}).session(session).lean();
  if(!record)throw F.fail('Loan is unavailable for repayment correction',409);
  const p=await models(conn).payment.findOne({_id:pid,tenantId:current.tenant._id,loanId:id}).session(session).lean();
  if(!p)throw F.fail('Original repayment not found',404);
  const reversed=await models(conn).correction.find({loanId:id,tenantId:current.tenant._id}).select('paymentId').session(session).lean();
  if(reversed.some(entry=>String(entry.paymentId)===String(pid)))
   throw F.fail('This repayment was already reversed',409);
  const latest=await models(conn).payment.findOne({loanId:id,_id:{$nin:reversed.map(entry=>entry.paymentId)}}).sort({createdAt:-1,_id:-1}).session(session).lean();
  if(!latest||String(latest._id)!==String(pid))
   throw F.fail('Correct the latest uncorrected repayment first. Historical repayments must remain in order.',409);
  const newPrincipal=BigInt(String(record.principalOutstandingMinor))+BigInt(String(p.principalMinor)),
   newInterest=BigInt(String(record.interestOutstandingMinor))+BigInt(String(p.interestMinor));
  if(newPrincipal>BigInt(String(record.principalMinor))||newInterest>BigInt(String(record.interestMinor)))
   throw F.fail('Repayment correction exceeds original loan contract',409);
  const auth=await treasury.access(conn,current.tenant,current.actor,{permission:'treasury.review',session,fence:true,sourceType:'loans'});
  const reversed=await treasury.reverseMovements(conn,session,auth,{
   sourceType:'loans',batchId:p.batchId,
   reversalSourceRef:'LOAN:'+id+':REV:'+pid,
   description:'Independent loan repayment correction: '+reason,
   evidenceReference:reference});
  const loanRow=await models(conn).loan.findOneAndUpdate({_id:id,revision:record.revision},{$set:{
   principalOutstandingMinor:F.d(newPrincipal),interestOutstandingMinor:F.d(newInterest),
   status:'active'
  },$inc:{revision:1}},{session,new:true});
  if(!loanRow)throw F.fail('Loan changed during correction',409);
  const [correction]=await models(conn).correction.create([{
   tenantId:current.tenant._id,branchId:p.branchId,loanId:id,paymentId:pid,
   reversalBatchId:reversed.batch._id,reference,reason,
   principalMinor:p.principalMinor,interestMinor:p.interestMinor,
   amountMinor:p.amountMinor,currency:p.currency,createdBy:F.oid(current.actor.id)
  }],{session});
  await F.audit(conn,session,current.actor,id,'loans.repayment.reversed',{
   branchId:String(record.branchId),originalPaymentId:String(pid),reversalBatchId:String(reversed.batch._id),reason,reference});
  return correction;
 });
}
async function portfolioSummary(conn,tenantId,filter){
 const rows=await models(conn).loan.aggregate([
  {$match:{tenantId,...filter,status:{$in:['active','paid']}}},
  {$group:{_id:'$currency',issued:{$sum:'$principalMinor'},
   principalOutstanding:{$sum:'$principalOutstandingMinor'},
   interestOutstanding:{$sum:'$interestOutstandingMinor'},
   late:{$sum:{$cond:[{$and:[{$eq:['$status','active']},{$lt:['$dueAt',new Date()]}]},1,0]}}}}
 ]);
 return rows.map(row=>({currency:row._id,issued:String(row.issued||'0'),
  principalOutstanding:String(row.principalOutstanding||'0'),
  interestOutstanding:String(row.interestOutstanding||'0'),late:Number(row.late||0)}));
}
async function list(conn,tenant,actor){
 const current=await F.access(conn,tenant,actor,'loans','loans.view');
 const [products,loans,summary]=await Promise.all([
  models(conn).product.find({tenantId:current.tenant._id,...F.scope(current.actor)}).sort({createdAt:-1}).limit(100).lean(),
  models(conn).loan.find({tenantId:current.tenant._id,...F.scope(current.actor)}).sort({createdAt:-1}).limit(200).lean(),
  portfolioSummary(conn,current.tenant._id,F.scope(current.actor))
 ]);
 return {products,loans,summary};
}
async function detail(conn,tenant,actor,loanId){
 const current=await F.access(conn,tenant,actor,'loans','loans.view'),id=F.oid(loanId,'loan');
 const loan=await models(conn).loan.findOne({_id:id,tenantId:current.tenant._id,...F.scope(current.actor)}).lean();
 if(!loan)throw F.fail('Loan record not found',404);
 const [payments,customer,corrections]=await Promise.all([
  models(conn).payment.find({loanId:id,tenantId:current.tenant._id}).sort({createdAt:-1}).limit(200).lean(),
  customerModel(conn).findOne({_id:loan.customerId,branchId:loan.branchId}).select('_id name phone reference').lean(),
  models(conn).correction.find({loanId:id,tenantId:current.tenant._id}).lean()
 ]);
 return {loan,payments,customer,corrections};
}
module.exports={createProduct,apply,review,disburse,repay,reverseRepayment,list,detail,summaryRows,interest};
