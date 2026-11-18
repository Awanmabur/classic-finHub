'use strict';
// Real, internal customer-account currency conversion. NOT a bank wire,
// cash receipt, external account transfer, or provider payment.
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const core=require('../models');
const accounts=require('../customerAccounts/models');
const {model:Fx,ensure:ensureFx}=require('../schemas/BankingInternalFx.schema');
const financialAuth=require('./financialAuthorization.service');
const {hasPermission,hasModuleForUser}=require('./moduleAccess.service');
const treasury=require('../treasury/service');
const treasuryModels=require('../treasury/models');
const forex=require('./forex.service');
const currencySupport=require('./branchCurrency.service');
const OID=/^[a-f0-9]{24}$/i;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function id(value){if(!OID.test(String(value||'')))throw fail('Choose a valid customer account or rate');return String(value);}
function ref(value){if(typeof value!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,119}$/.test(value.trim()))
 throw fail('Enter the customer-approved transfer voucher reference, 6–120 characters');return value.trim();}
function eligible(tenant,actor){
 return hasModuleForUser(tenant,actor,'banking')&&hasModuleForUser(tenant,actor,'forex')&&
  hasModuleForUser(tenant,actor,'accounts')&&hasPermission(actor,'banking.requests.create')&&
  hasPermission(actor,'forex.quotes.create')&&hasPermission(actor,'accounts.view')&&hasPermission(actor,'treasury.observe')&&
  ['Tenant Owner','Banking Operator'].includes(actor.role);
}
async function options(conn,tenant,actor,branch){
 if(!branch||branch.status!=='active'||!eligible(tenant,actor))throw fail('Banking, Forex, customer-account and financial operation access is required',403);
 if(actor.role!=='Tenant Owner'&&String(actor.branchId)!==String(branch._id))throw fail('Branch assignment changed',403);
 const [customerAccounts,rates]=await Promise.all([
  accounts.accountModel(conn).aggregate([
   {$match:{branchId:branch._id,status:'active',currency:{$in:currencySupport.supported(branch)}}},
   {$lookup:{from:accounts.customerModel(conn).collection.name,localField:'customerId',foreignField:'_id',as:'customer'}},
   {$unwind:'$customer'},{$match:{'customer.status':'active','customer.branchId':branch._id}},
   {$sort:{accountNumber:1}},{$limit:201},
   {$project:{_id:1,customerId:1,ledgerAccountId:1,accountNumber:1,currency:1,customerName:'$customer.name'}}
  ]).option({maxTimeMS:3000}),
  core.forexRateModel(conn).find({branchId:branch._id,status:'active',side:{$in:['buy','sell']},
   expiresAt:{$gt:new Date()},reviewedBy:{$ne:null}}).select('fromCurrency toCurrency side rateDecimal revision expiresAt')
   .sort({fromCurrency:1,toCurrency:1,side:1}).limit(100).lean()
 ]);
 if(customerAccounts.length>200)throw fail('More than 200 customer accounts. Narrow the branch account list before exchanging.',422);
 const ledgerIds=customerAccounts.map(account=>account.ledgerAccountId);
 const postings=ledgerIds.length?await core.ledgerPostingModel(conn).aggregate([
  {$match:{accountId:{$in:ledgerIds},branchId:branch._id}},
  {$group:{_id:{accountId:'$accountId',side:'$side',currency:'$currency'},amount:{$sum:'$amountMinor'}}}
 ]).option({maxTimeMS:3000}):[];
 const balances=new Map();
 for(const row of postings){
  const key=String(row._id.accountId),sign=row._id.side==='credit'?1n:-1n;
  balances.set(key,(balances.get(key)||0n)+BigInt(String(row.amount))*sign);
 }
 return {accounts:customerAccounts.map(account=>({...account,
  balanceMinor:String(balances.get(String(account.ledgerAccountId))||0n),
  balanceLabel:require('./mobileMoney.service').formatMoneyMinor(
   String(balances.get(String(account.ledgerAccountId))||0n),account.currency)
 })),rates};
}
async function balance(conn,session,ledgerId,branchId,currency){
 const groups=await core.ledgerPostingModel(conn).aggregate([
  {$match:{accountId:new mongoose.Types.ObjectId(String(ledgerId)),
   branchId:new mongoose.Types.ObjectId(String(branchId)),currency}},
  {$group:{_id:'$side',amount:{$sum:'$amountMinor'}}}
 ]).session(session);
 return groups.reduce((n,g)=>n+BigInt(String(g.amount))*(g._id==='credit'?1n:-1n),0n);
}
async function convert(conn,tenant,actor,branch,input={}){
 if(!branch||!eligible(tenant,actor)||actor.role!=='Tenant Owner'&&String(actor.branchId)!==String(branch._id))
  throw fail('You cannot post Banking currency exchanges for this branch',403);
 const sourceId=id(input.sourceAccountId),destinationId=id(input.destinationAccountId),rateId=id(input.rateId);
 if(sourceId===destinationId)throw fail('Choose two different customer accounts and currencies');
 if(!UUID.test(String(input.idempotencyKey||'')))throw fail('Reload to get a valid exchange reference');
 if(input.confirmCustomerAuthority!=='yes')throw fail('Confirm customer authorization for the internal account exchange');
 const voucher=ref(input.evidenceReference);
 if(typeof input.amount!=='string'||input.amount.length>32)throw fail('Enter the source account amount');
 const originalRateVersion=Number(input.rateVersion);
 if(!Number.isSafeInteger(originalRateVersion)||originalRateVersion<0)throw fail('The rate has changed. Refresh and try again',409);
 await Promise.all([accounts.ensureIndexes(conn),treasuryModels.ensure(conn),ensureFx(conn)]);
 const Existing=Fx(conn),prior=await Existing.findOne({tenantId:tenant._id,idempotencyKey:input.idempotencyKey}).lean();
 if(prior){
  const sourceAmount=forex.minor(input.amount,prior.sourceCurrency);
  if(String(prior.createdBy)!==String(actor.id)||String(prior.sourceAccountId)!==sourceId||
     String(prior.destinationAccountId)!==destinationId||String(prior.rateId)!==rateId||
     Number(prior.rateVersion)!==originalRateVersion||String(prior.sourceAmountMinor)!==String(sourceAmount)||
     prior.evidenceReference!==voucher)throw fail('Exchange reference is already used for a different transaction',409);
  return {record:prior,duplicate:true};
 }
 const session=await conn.startSession();
 try{
  let result;
  await session.withTransaction(async()=>{
   const authorization=await financialAuth.fenceAction(conn,session,actor,tenant,'banking','banking.requests.create',
    {branchId:String(branch._id)});
   if(!eligible(authorization.tenant,authorization.actor))throw fail('Cross-module Banking Forex entitlement changed',403);
   const active=await core.branchModel(conn).findOneAndUpdate({_id:branch._id,status:'active'},
    {$inc:{revision:1}},{session,new:true}).lean();
   if(!active)throw fail('Banking branch is no longer active',409);
   const source=await accounts.accountModel(conn).findOneAndUpdate({_id:sourceId,branchId:branch._id,status:'active'},
    {$inc:{revision:1}},{session,new:true}).lean();
   const destination=await accounts.accountModel(conn).findOneAndUpdate({_id:destinationId,branchId:branch._id,status:'active'},
    {$inc:{revision:1}},{session,new:true}).lean();
   if(!source||!destination||String(source.customerId)!==String(destination.customerId)||
      source.currency===destination.currency)
    throw fail('Both active accounts must belong to the same customer and use different currencies',409);
   for(const code of [source.currency,destination.currency])currencySupport.resolve(active,code);
   const owner=await accounts.customerModel(conn).findOne({_id:source.customerId,
    branchId:branch._id,status:'active'}).session(session).lean();
   if(!owner)throw fail('Customer is inactive or belongs to a different branch',403);
   const [srcLedger,destLedger]=await Promise.all([
    core.ledgerAccountModel(conn).findOne({_id:source.ledgerAccountId,branchId:branch._id,
      currency:source.currency,category:'liability'}).session(session).lean(),
    core.ledgerAccountModel(conn).findOne({_id:destination.ledgerAccountId,branchId:branch._id,
      currency:destination.currency,category:'liability'}).session(session).lean()
   ]);
   if(!srcLedger||!destLedger)throw fail('Bank customer liability mapping is invalid',503);
   const rate=await core.forexRateModel(conn).findOne({_id:rateId,branchId:branch._id,
    status:'active',side:{$in:['buy','sell']},
    fromCurrency:source.currency,toCurrency:destination.currency,reviewedBy:{$ne:null},
    revision:originalRateVersion,expiresAt:{$gt:new Date()}}).session(session).lean();
   if(!rate||String(rate.rateDecimal)!==String(input.rateDecimal||''))throw fail('Approved exchange rate expired or changed. Refresh',409);
   const sourceMinor=forex.minor(input.amount,source.currency);
   const destinationMinor=forex.converted(sourceMinor,source.currency,destination.currency,
    forex.rateScaled(rate.rateDecimal));
   const available=await balance(conn,session,source.ledgerAccountId,branch._id,source.currency);
   if(available<sourceMinor)throw fail('Insufficient posted customer balance in the source currency',409);
   // One immutable source, two currency-specific balanced journals, and no
   // provider cash movement. Settlement-clearing ledger positions record FX
   // exposure without fabricating trading profit or bank settlement.
   const authorizationTreasury=await treasury.access(conn,authorization.tenant,authorization.actor,{
    permission:'treasury.observe',sourceType:'forex',session,fence:true});
   const posting=await treasury.applyMovements(conn,session,authorizationTreasury,{
    sourceType:'forex',sourceRef:'BANKFX:'+input.idempotencyKey,
    branchId:String(branch._id),operatingActorId:String(actor.id),
    legs:[],ledgerLines:[
     {accountId:String(source.ledgerAccountId),currency:source.currency,side:'debit',amountMinor:String(sourceMinor)},
     {accountId:String(destination.ledgerAccountId),currency:destination.currency,side:'credit',amountMinor:String(destinationMinor)}
    ],description:'Internal customer account FX '+source.currency+'/'+destination.currency,
    evidenceReference:voucher
   });
   if(posting.duplicate)throw fail('Existing currency movement requires reconciliation before retrying',409);
   if(posting.journalIds.length!==2)throw fail('Both currency ledgers were not posted',503);
   const [record]=await Existing.create([{tenantId:tenant._id,branchId:branch._id,createdBy:actor.id,
    idempotencyKey:input.idempotencyKey,evidenceReference:voucher,customerId:source.customerId,
    sourceAccountId:source._id,destinationAccountId:destination._id,
    sourceCurrency:source.currency,destinationCurrency:destination.currency,
    sourceAmountMinor:String(sourceMinor),destinationAmountMinor:String(destinationMinor),
    rateId:rate._id,rateSide:rate.side,rateVersion:rate.revision,rateDecimal:rate.rateDecimal,
    journalBatchId:posting.batch._id,journalIds:posting.journalIds,postedAt:new Date()}],{session});
   await core.auditEventModel(conn).create([{action:'banking.fx.posted_internal',actorId:actor.id,targetId:record._id,
    metadata:{branchId:String(branch._id),sourceCurrency:source.currency,destinationCurrency:destination.currency,
     sourceMinor:String(sourceMinor),destinationMinor:String(destinationMinor),rateId:String(rate._id)}}],{session});
   result={record,duplicate:false};
  },{readConcern:{level:'snapshot'}});
  return result;
 }catch(error){
  if(error.code===11000)throw fail('This internal exchange reference already posted; refresh history before retrying',409);
  throw error;
 }finally{await session.endSession();}
}
async function history(conn,tenant,actor,branch){
 if(!branch||!eligible(tenant,actor))throw fail('Banking Forex history requires module access',403);
 const scope={tenantId:tenant._id,branchId:branch._id,...(actor.role==='Tenant Owner'?{}:{createdBy:actor.id})};
 return Fx(conn).find(scope).sort({postedAt:-1,_id:-1}).limit(100).lean();
}
module.exports={options,convert,history,eligible,fail,balance};
