'use strict';
// INTERNAL INDICATIVE RATES AND QUOTATIONS ONLY. No currency is bought,
// sold, held, delivered, posted to a ledger, or settled in this module.
const crypto=require('node:crypto');
const financialAuth=require('./financialAuthorization.service');
const mongoose=require('mongoose');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const {forexRateModel,forexQuoteModel,branchModel,auditEventModel,ensureTenantIndexes}=require('../models');
const {reserveUsage}=require('../../platform/services/commercial.service');
const mobile=require('./mobileMoney.service');
const OID=/^[a-f\d]{24}$/i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const {forexCurrencies:DECIMALS,currencyCodes}=require('../../config/currencies');
const RATE_SCALE=100000000n;
const SYSTEM_ACTOR='000000000000000000000000';
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
function id(value){if(!OID.test(String(value||'')))throw fail('Invalid identifier');return String(value);}
function text(value,label,min=1,max=120){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)throw fail(`Invalid ${label}`);return value.trim();}
function currency(value){if(typeof value!=='string'||!Object.hasOwn(DECIMALS,value))throw fail('Unsupported exchange currency');return value;}
function enabledPair(branch,from,to){for(const code of [from,to])if(require('../../config/currencies').currencyCodes.includes(code))require('./branchCurrency.service').resolve(branch,code);}
function enabledRate(branch,rate){return [rate.fromCurrency,rate.toCurrency].every(code=>code==='EUR'||require('./branchCurrency.service').supports(branch,code));}
function rateScaled(value){
 const valueText=text(value,'exchange rate',1,24);
 if(!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/.test(valueText))throw fail('Use a positive rate with no more than eight decimals');
 const [whole,fraction='']=valueText.split('.');
 const n=BigInt(whole)*RATE_SCALE+BigInt(fraction.padEnd(8,'0'));
 if(n===0n)throw fail('Rate must be greater than zero');return n;
}
function minor(value,ccy){
 const digits=DECIMALS[currency(ccy)];const amount=text(value,'source amount',1,32);
 const rx=digits?new RegExp(`^(?:0\\.\\d{1,${digits}}|[1-9]\\d{0,8}(?:\\.\\d{1,${digits}})?)$`):/^[1-9]\d{0,8}$/;
 if(!rx.test(amount))throw fail(`Enter a positive amount with at most ${digits} decimals`);
 const [whole,part='']=amount.split('.');const n=BigInt(whole)*10n**BigInt(digits)+BigInt(part.padEnd(digits,'0')||'0');
 if(n===0n)throw fail('Source amount must be greater than zero');return n;
}
function converted(sourceMinor,from,to,rate){
 const n=sourceMinor*rate*10n**BigInt(DECIMALS[currency(to)]);
 const d=RATE_SCALE*10n**BigInt(DECIMALS[currency(from)]);
 const rounded=(n+d/2n)/d;
 if(rounded<=0n||rounded>100000000000000000n)throw fail('Quote would be too small or exceed the supported limit');
 return rounded;
}
function amountLabel(value,ccy){const n=BigInt(String(value?.toString?.()??value)),digits=DECIMALS[currency(ccy)],absolute=n<0n?-n:n;
 const factor=10n**BigInt(digits),whole=(absolute/factor).toString(),fraction=digits?'.'+(absolute%factor).toString().padStart(digits,'0'):'';
 return `${ccy} ${n<0n?'-':''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')}${fraction}`;
}
function moduleAccess(tenant,actor,permission){
 if(!hasModuleForUser(tenant,actor,'forex')||!hasPermission(actor,permission))throw fail('Forex subscription or role permission unavailable',403);
}
function operator(actor){return ['Tenant Owner','Forex Operator'].includes(actor?.role);}
function reviewer(actor){return ['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(actor?.role);}
function branchScope(actor){
 if(['Tenant Owner','Auditor'].includes(actor?.role))return require('./branchView.service').readScope(actor);
 if(!OID.test(String(actor?.branchId||'')))throw fail('An assigned branch is required',403);
 return {branchId:id(actor.branchId)};
}
function quoteScope(actor){const scope=branchScope(actor);
 if(actor?.role==='Forex Operator')scope.createdBy=id(actor.id);
 return scope;
}
function branchFor(actor,input){return require('./transactionBranch.service').assignedBranchId(actor,input);}
function rateInput(input){
 const fromCurrency=currency(input?.fromCurrency),toCurrency=currency(input?.toCurrency);
 if(fromCurrency===toCurrency)throw fail('Exchange currencies must differ');
 const rateDecimal=text(input?.rateDecimal,'rate',1,24);rateScaled(rateDecimal);
 const validHours=Number(input?.validHours??24);
 if(!Number.isSafeInteger(validHours)||validHours<1||validHours>72)throw fail('Rate validity must be 1–72 hours');
 const note=text(input?.note,'rate justification',12,400);
 return {fromCurrency,toCurrency,rateDecimal,validHours,note};
}
function quoteInput(input){
 const operation=input?.operation||'quote';
 if(!['buy','sell','quote'].includes(operation))throw fail('Invalid exchange operation');
 const rateId=id(input?.rateId);const customerLabel=text(input?.customerLabel,'customer reference',2,120);
 const amount=text(input?.amount,'source amount',1,32);
 const note=text(input?.note,'quote purpose',12,400);
 const validMinutes=Number(input?.validMinutes??15);
 if(!Number.isSafeInteger(validMinutes)||validMinutes<5||validMinutes>60)throw fail('Quote validity must be 5–60 minutes');
 const idempotencyKey=text(input?.idempotencyKey,'form reference',36,36);
 if(!UUID.test(idempotencyKey))throw fail('Reload the form to obtain a valid request identifier');
 return {rateId,customerLabel,amount,note,validMinutes,idempotencyKey,operation,capture:require('./operationCapture.service').parse('forex',input)};
}
async function proposeRate(conn,tenant,actor,input){
 moduleAccess(tenant,actor,'forex.rate_manage');if(!operator(actor))throw fail('Only assigned Forex staff may propose rates',403);
 const v=rateInput(input),branchId=String((await require('./transactionBranch.service').resolveTransactionBranch(conn,actor,input))._id);await ensureTenantIndexes(conn);
 const session=await conn.startSession();let rate;
 try{await session.withTransaction(async()=>{
  const authorization=await financialAuth.fenceAction(conn,session,actor,tenant,'forex','forex.rate_manage',{branchId});
  const branch=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'active'},{$inc:{revision:1}},{session,new:true});
  if(!branch)throw fail('The assigned branch must be active',409);
  enabledPair(branch,v.fromCurrency,v.toCurrency);
  [rate]=await forexRateModel(conn).create([{branchId,fromCurrency:v.fromCurrency,toCurrency:v.toCurrency,
   rateDecimal:v.rateDecimal,expiresAt:new Date(Date.now()+v.validHours*3600000),note:v.note,proposedBy:actor.id}],{session});
  await auditEventModel(conn).create([{action:'forex.rate.proposed',actorId:actor.id,targetId:rate._id,
   metadata:{branchId,pair:`${v.fromCurrency}/${v.toCurrency}`,rate:v.rateDecimal}}],{session});
 });return rate;}finally{await session.endSession();}
}
async function decideRate(conn,tenant,actor,rateId,input){
 moduleAccess(tenant,actor,'forex.rate_review');if(!reviewer(actor))throw fail('Independent rate reviewer required',403);
 const decision=input?.decision;if(!['approve','reject'].includes(decision))throw fail('Invalid rate decision');
 const note=text(input?.note,'review explanation',12,400);await ensureTenantIndexes(conn);
 const session=await conn.startSession();let updated;
 try{await session.withTransaction(async()=>{
  const authorization=await financialAuth.fenceAction(conn,session,actor,tenant,'forex','forex.rate_review');
  const Rate=forexRateModel(conn);
  const current=await Rate.findOne({_id:id(rateId),status:'pending_review',proposedBy:{$ne:id(actor.id)},expiresAt:{$gt:new Date()},...branchScope(actor)}).session(session);
  if(!current)throw fail('Rate expired, already reviewed, outside your branch, or proposed by you',409);
  if(decision==='approve'){
   const branch=await branchModel(conn).findOneAndUpdate({_id:current.branchId,status:'active'},{$inc:{revision:1}},{session,new:true});
   if(!branch)throw fail('The assigned branch must be active',409);
   enabledPair(branch,current.fromCurrency,current.toCurrency);
   const newer=await Rate.exists({branchId:current.branchId,fromCurrency:current.fromCurrency,toCurrency:current.toCurrency,
    status:'active',createdAt:{$gt:current.createdAt}}).session(session);
   if(newer)throw fail('A newer indicative rate is already active; review the latest proposal instead',409);
   await Rate.updateMany({branchId:current.branchId,fromCurrency:current.fromCurrency,toCurrency:current.toCurrency,status:'active'},
    {$set:{status:'superseded'},$inc:{revision:1}},{session});
  }
  updated=await Rate.findOneAndUpdate({_id:current._id,status:'pending_review',revision:current.revision,expiresAt:{$gt:new Date()}},
   {$set:{status:decision==='approve'?'active':'rejected',reviewedBy:actor.id,reviewedAt:new Date(),reviewNote:note},$inc:{revision:1}},
   {session,new:true});
  if(!updated)throw fail('Rate changed during review',409);
  await auditEventModel(conn).create([{action:`forex.rate.${decision==='approve'?'approved':'rejected'}`,actorId:actor.id,
   targetId:updated._id,metadata:{branchId:String(updated.branchId),pair:`${updated.fromCurrency}/${updated.toCurrency}`}}],{session});
 });return updated;}
 catch(e){if(e.code===11000)throw fail('Another active rate was approved concurrently. Refresh.',409);throw e;}
 finally{await session.endSession();}
}
function identical(existing,actor,branchId,v){return String(existing.createdBy)===String(actor.id)&&String(existing.branchId)===branchId&&
 String(existing.rateId)===v.rateId&&existing.customerLabel===v.customerLabel&&existing.note===v.note&&
 existing.sourceMinor.toString()===v.sourceMinor.toString()&&existing.expiresAt.getTime()===v.expiresAt.getTime();}
// The requested expiry is fixed on creation. For idempotent requests, compare
// their immutable input fields, not the moving clock-based expiry.
function equivalent(existing,actor,branchId,v){return String(existing.createdBy)===String(actor.id)&&String(existing.branchId)===branchId&&
 (existing.operation||'quote')===(v.operation||'quote')&&require('./operationCapture.service').equivalent('forex',existing.capture,v.capture)&&
 String(existing.rateId)===v.rateId&&existing.customerLabel===v.customerLabel&&existing.note===v.note&&
 existing.sourceMinor.toString()===v.sourceMinor.toString()&&existing.validMinutes===v.validMinutes;}
function quoteEconomics(input,rate){
 if(['buy','sell'].includes(input.operation)&&(!currencyCodes.includes(rate.fromCurrency)||!currencyCodes.includes(rate.toCurrency)))throw fail('Buy and sell operations require currencies supported by the funds books',409);
 const sourceMinor=minor(input.amount,rate.fromCurrency);
 const targetMinor=converted(sourceMinor,rate.fromCurrency,rate.toCurrency,rateScaled(rate.rateDecimal));
 const proposedFee=require('./operationCapture.service').commissionMinor(input.capture,rate.toCurrency);
 if(proposedFee>targetMinor)throw fail('Commission / fee cannot exceed the quoted settlement amount');
 if(input.operation==='buy'&&proposedFee===targetMinor)throw fail('Commission must leave a positive customer settlement amount');
 return {sourceMinor,targetMinor};
}
async function createQuote(conn,tenant,actor,input){
 moduleAccess(tenant,actor,'forex.quotes.create');if(!operator(actor))throw fail('Quote creation role required',403);
 const v=quoteInput(input),branchId=String((await require('./transactionBranch.service').resolveTransactionBranch(conn,actor,input))._id);await ensureTenantIndexes(conn);
 const Quote=forexQuoteModel(conn),existing=await Quote.findOne({idempotencyKey:v.idempotencyKey}).lean();
 if(existing){const base=minor(v.amount,existing.fromCurrency);
  if(!equivalent(existing,actor,branchId,{...v,sourceMinor:base}))throw fail('Request reference reused with different quote details',409);
  return {quote:existing,duplicate:true};}
 const session=await conn.startSession();let quote;
 try{await session.withTransaction(async()=>{
  const authorization=await financialAuth.fenceAction(conn,session,actor,tenant,'forex','forex.quotes.create',{branchId});
  const Rate=forexRateModel(conn);const now=new Date();
  const rate=await Rate.findOneAndUpdate({_id:v.rateId,branchId,status:'active',expiresAt:{$gt:new Date(now.getTime()+v.validMinutes*60000)}},
   {$inc:{revision:1}},{session,new:true});
  if(!rate)throw fail('The approved rate is unavailable or expires before this quote',409);
  const {sourceMinor,targetMinor}=quoteEconomics(v,rate);
  const branch=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'active'},{$inc:{revision:1}},{session,new:true});
  if(!branch)throw fail('Assigned branch is unavailable',409);
  enabledPair(branch,rate.fromCurrency,rate.toCurrency);
  await reserveUsage(authorization.tenant,'forex_quotes',session);
  [quote]=await Quote.create([{reference:`FX-${crypto.randomBytes(12).toString('hex').toUpperCase()}`,
   idempotencyKey:v.idempotencyKey,branchId,createdBy:actor.id,customerLabel:v.customerLabel,operation:v.operation,capture:v.capture,rateId:rate._id,
   fromCurrency:rate.fromCurrency,toCurrency:rate.toCurrency,rateDecimal:rate.rateDecimal,
   sourceMinor:String(sourceMinor),targetMinor:String(targetMinor),note:v.note,validMinutes:v.validMinutes,
   expiresAt:new Date(now.getTime()+v.validMinutes*60000)}],{session});
  await auditEventModel(conn).create([{action:'forex.quote.created',actorId:actor.id,targetId:quote._id,
   metadata:{branchId,reference:quote.reference,operation:v.operation,pair:`${rate.fromCurrency}/${rate.toCurrency}`}}],{session});
 });return {quote,duplicate:false};}
 catch(e){if(e.code===11000){const found=await Quote.findOne({idempotencyKey:v.idempotencyKey}).lean();
  if(found&&equivalent(found,actor,branchId,{...v,sourceMinor:minor(v.amount,found.fromCurrency)}))return {quote:found,duplicate:true};
  throw fail('Quote identifier already used',409);}throw e;}
 finally{await session.endSession();}
}
async function decideQuote(conn,tenant,actor,quoteId,input){
 moduleAccess(tenant,actor,'forex.quotes.review');if(!reviewer(actor))throw fail('Independent reviewer required',403);
 const decision=input?.decision;if(!['approve','reject'].includes(decision))throw fail('Invalid quote decision');
 const note=text(input?.note,'review reason',12,400);await ensureTenantIndexes(conn);
 const session=await conn.startSession();let updated;
 try{await session.withTransaction(async()=>{
  const authorization=await financialAuth.fenceAction(conn,session,actor,tenant,'forex','forex.quotes.review');
  updated=await forexQuoteModel(conn).findOneAndUpdate({_id:id(quoteId),status:'quoted',createdBy:{$ne:id(actor.id)},expiresAt:{$gt:new Date()},...branchScope(actor)},
   {$set:{status:decision==='approve'?'approved_pending_execution':'rejected',reviewedBy:actor.id,reviewedAt:new Date(),reviewNote:note},$inc:{revision:1}},
   {session,new:true});
  if(!updated)throw fail('Quote expired, already decided, outside your branch or submitted by you',409);
  await auditEventModel(conn).create([{action:`forex.quote.${decision==='approve'?'approved':'rejected'}`,actorId:actor.id,
   targetId:updated._id,metadata:{branchId:String(updated.branchId),reference:updated.reference}}],{session});
 });return updated;}finally{await session.endSession();}
}
async function cancelQuote(conn,tenant,actor,quoteId,input){
 moduleAccess(tenant,actor,'forex.view');const note=text(input?.note,'cancellation reason',12,400);await ensureTenantIndexes(conn);
 const session=await conn.startSession();let updated;
 try{await session.withTransaction(async()=>{
  const authorization=await financialAuth.fenceAction(conn,session,actor,tenant,'forex','forex.view');
  updated=await forexQuoteModel(conn).findOneAndUpdate({_id:id(quoteId),status:'quoted',...branchScope(actor),
   ...(actor.role==='Tenant Owner'?{}:{createdBy:id(actor.id)})},
   {$set:{status:'cancelled',cancelledBy:actor.id,cancelledAt:new Date(),cancelNote:note},$inc:{revision:1}},
   {session,new:true});
  if(!updated)throw fail('Only the originator or tenant owner can cancel an undecided quote',409);
  await auditEventModel(conn).create([{action:'forex.quote.cancelled',actorId:actor.id,targetId:updated._id,
   metadata:{branchId:String(updated.branchId),reference:updated.reference}}],{session});
 });return updated;}finally{await session.endSession();}
}
async function listRates(conn,tenant,actor,{status=null,branchId=null}={}){
 moduleAccess(tenant,actor,'forex.view');if(status&&!['pending_review','active','rejected','superseded','expired'].includes(status))throw fail('Invalid rate status');
 const scope=branchScope(actor);
 if(branchId){id(branchId);if(scope.branchId&&String(scope.branchId)!==String(branchId))throw fail('Cross-branch rate access forbidden',403);scope.branchId=branchId;}
 return forexRateModel(conn).find({...scope,...(status?{status}:{})}).sort({createdAt:-1,_id:-1}).limit(100).lean();
}
async function rateReviewQueue(conn,tenant,actor){
 moduleAccess(tenant,actor,'forex.rate_review');if(!reviewer(actor))throw fail('Independent reviewer required',403);
 return forexRateModel(conn).find({status:'pending_review',proposedBy:{$ne:id(actor.id)},expiresAt:{$gt:new Date()},...branchScope(actor)}).sort({createdAt:1}).limit(30).lean();
}
async function listQuotes(conn,tenant,actor,{status=null,cursor=null}={}){
 moduleAccess(tenant,actor,'forex.view');
 if(status&&!['quoted','approved_pending_execution','posted_manual','rejected','cancelled','expired'].includes(status))throw fail('Invalid quote status');
 const position=mobile.decodeCursor(cursor),query={...quoteScope(actor),...(status?{status}:{})};
 if(position)query.$or=[{createdAt:{$lt:position.at}},{createdAt:position.at,_id:{$lt:id(position.id)}}];
 const found=await forexQuoteModel(conn).find(query).sort({createdAt:-1,_id:-1}).limit(41).lean();
 const items=found.slice(0,40);return {items,nextCursor:found.length>40?mobile.encodeCursor(items.at(-1)):null};
}
async function recent(conn,tenant,actor){
 moduleAccess(tenant,actor,'forex.view');
 return forexQuoteModel(conn).find(quoteScope(actor)).select('operation customerLabel sourceMinor fromCurrency reference createdAt status').sort({createdAt:-1,_id:-1}).limit(14).lean();
}
async function detail(conn,tenant,actor,quoteId){
 moduleAccess(tenant,actor,'forex.view');const quote=await forexQuoteModel(conn).findOne({_id:id(quoteId),...quoteScope(actor)}).lean();
 if(!quote)throw fail('Forex quote not found in authorized scope',404);return quote;
}
async function quoteReviewQueue(conn,tenant,actor){
 moduleAccess(tenant,actor,'forex.quotes.review');if(!reviewer(actor))throw fail('Reviewer role required',403);
 return forexQuoteModel(conn).find({status:'quoted',createdBy:{$ne:id(actor.id)},expiresAt:{$gt:new Date()},...branchScope(actor)}).sort({createdAt:1}).limit(30).lean();
}
async function expireDue(conn,now=new Date(),limit=100){
 if(!(now instanceof Date)||!Number.isFinite(now.getTime())||!Number.isSafeInteger(limit)||limit<1||limit>200)throw fail('Invalid expiry sweep');
 await ensureTenantIndexes(conn);
 let expiredRates=0,expiredQuotes=0;
 for(const [model,statuses,action,onChange] of [
  [forexRateModel(conn),['pending_review','active'],'forex.rate.expired',()=>expiredRates++],
  [forexQuoteModel(conn),['quoted'],'forex.quote.expired',()=>expiredQuotes++]]){
  const due=await model.find({status:{$in:statuses},expiresAt:{$lte:now}}).select('_id').sort({expiresAt:1,_id:1}).limit(limit).lean();
  for(const item of due){const session=await conn.startSession();let changed=false;try{await session.withTransaction(async()=>{
   const updated=await model.findOneAndUpdate({_id:item._id,status:{$in:statuses},expiresAt:{$lte:now}},
    {$set:{status:'expired',...(action==='forex.quote.expired'?{expiredAt:now}:{})},$inc:{revision:1}},{new:true,session});
   if(!updated)return;
   await auditEventModel(conn).create([{action,actorId:SYSTEM_ACTOR,targetId:updated._id,
    metadata:{branchId:String(updated.branchId),system:true}}],{session});changed=true;
  });if(changed)onChange();}finally{await session.endSession();}}
 }
 return {expiredRates,expiredQuotes};
}
async function reportRows({conn,filters,scope}){
 const query={createdAt:mobile.dateBounds({from:filters.from,to:filters.to}),
  ...(scope.branchId?{branchId:new mongoose.Types.ObjectId(id(scope.branchId))}:{}),
  ...(scope.operatorId?{createdBy:new mongoose.Types.ObjectId(id(scope.operatorId))}:{})};
 const found=await forexQuoteModel(conn).aggregate([{$match:query},{$group:{_id:{from:'$fromCurrency',to:'$toCurrency',status:'$status'},
  count:{$sum:1},amount:{$sum:'$sourceMinor'},target:{$sum:'$targetMinor'}}},{$sort:{'_id.from':1,'_id.to':1,'_id.status':1}},{$limit:501}]);
 if(found.length>500)throw fail('Too many forex report groups',422);
 return found.map(r=>({module:'Forex',activity:`${r._id.from} → ${r._id.to} indicative quote`,status:r._id.status,
  currency:r._id.from,count:r.count,amountMinor:r.amount?.toString()||'0',feesMinor:'0',targetCurrency:r._id.to,targetAmountMinor:r.target?.toString()||'0',
  volume:amountLabel(r.amount?.toString()||'0',r._id.from),fees:amountLabel('0',r._id.from)}));
}
const unavailable=require('../../utils/unavailableOperation');
const buy=()=>unavailable('forex currency purchase');const sell=()=>unavailable('forex currency sale');
module.exports={fail,id,text,currency,rateScaled,minor,converted,amountLabel,enabledRate,moduleAccess,operator,reviewer,branchScope,quoteScope,branchFor,
 rateInput,quoteInput,quoteEconomics,proposeRate,decideRate,createQuote,decideQuote,cancelQuote,listRates,rateReviewQueue,listQuotes,recent,detail,quoteReviewQueue,expireDue,reportRows,buy,sell};
