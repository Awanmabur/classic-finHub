'use strict';
// Internal Mobile Money currency pricing: approving a rate does not verify any
// external FX market or move money. It is included in Mobile Money, not locked
// behind the separately licensed Forex customer-trading module.
const {Types}=require('mongoose');
const {currencyCodes}=require('../../config/currencies');
const {forexRateModel,branchModel,auditEventModel}=require('../models');
const {rateScaled}=require('../services/forex.service');
const {fenceAction}=require('../services/financialAuthorization.service');
const branchCurrency=require('../services/branchCurrency.service');
function fail(message,status=400){return Object.assign(new Error(message),{status});}
const OID=/^[a-f0-9]{24}$/i;
const MAKERS=new Set(['Tenant Owner','Mobile Money Operator']);
const REVIEWERS=new Set(['Tenant Owner','Branch Manager','Reconciliation Officer']);
const clean=(v,label,min=1,max=400)=>{
 if(typeof v!=='string'||v.trim().length<min||v.trim().length>max||/[\u0000-\u001f\u007f]/.test(v))
  throw fail('Enter a valid '+label);
 return v.trim();
};
function proposal(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Invalid rate proposal');
 const fromCurrency=clean(input.fromCurrency,'provider currency',3,3);
 const toCurrency=clean(input.toCurrency,'cash currency',3,3);
 if(!currencyCodes.includes(fromCurrency)||!currencyCodes.includes(toCurrency)||fromCurrency===toCurrency)
  throw fail('Choose two different supported wallet and physical cash currencies');
 const side=clean(input.side,'Buy/Sell side',3,4);
 if(!['buy','sell'].includes(side))throw fail('Choose Buy or Sell');
 const rateDecimal=clean(input.rateDecimal,'rate',1,24);
 if(rateScaled(rateDecimal)<=0n)throw fail('Rate must be positive');
 const hours=Number(input.validHours||'24');
 if(!Number.isSafeInteger(hours)||hours<1||hours>72)
  throw fail('Rate validity must be from 1 to 72 hours');
 const note=clean(input.note,'rate evidence or justification',12,400);
 return {fromCurrency,toCurrency,side,rateDecimal,hours,note};
}
function decision(input={}){
 if(!['approve','reject'].includes(input.decision))throw fail('Choose an approval decision');
 return {decision:input.decision,note:clean(input.note,'review evidence',12,400)};
}
async function propose(conn,tenant,actor,branchId,input){
 const values=proposal(input);
 if(!MAKERS.has(actor?.role))throw fail('Only the assigned Mobile Money cashier or tenant owner can propose a rate',403);
 if(!OID.test(String(branchId||'')))throw fail('Choose an operating branch first',409);
 const session=await conn.startSession();let created;
 try{
  await session.withTransaction(async()=>{
   const authorization=await fenceAction(conn,session,actor,tenant,'mobile_money','mobile_money.view',{branchId:String(branchId)});
   if(!MAKERS.has(authorization.actor.role))throw fail('Cashier rate access changed',403);
   const branch=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'active'},{$inc:{revision:1}},{new:true,session}).lean();
   if(!branch)throw fail('The operating branch is unavailable',409);
   branchCurrency.resolve(branch,values.fromCurrency);
   branchCurrency.resolve(branch,values.toCurrency);
   [created]=await forexRateModel(conn).create([{
    branchId:branch._id,fromCurrency:values.fromCurrency,toCurrency:values.toCurrency,
    side:values.side,rateDecimal:values.rateDecimal,
    expiresAt:new Date(Date.now()+values.hours*3600000),
    note:values.note,proposedBy:authorization.actor.id
   }],{session});
   await auditEventModel(conn).create([{
    action:'forex.rate.proposed',actorId:authorization.actor.id,targetId:created._id,
    metadata:{branchId:String(branch._id),pair:values.fromCurrency+'/'+values.toCurrency,
      side:values.side,source:'mobile_money_currency_rates'}
   }],{session});
  });
  return created;
 }finally{await session.endSession();}
}
async function review(conn,tenant,actor,branchId,rateId,input){
 const values=decision(input);
 if(!REVIEWERS.has(actor?.role))throw fail('An independent authorized reviewer is required',403);
 if(!OID.test(String(rateId||''))||!OID.test(String(branchId||'')))throw fail('Invalid rate or operating branch',400);
 const session=await conn.startSession();let result;
 try{
  await session.withTransaction(async()=>{
   const authorization=await fenceAction(conn,session,actor,tenant,'mobile_money','mobile_money.view',{branchId:String(branchId)});
   if(!REVIEWERS.has(authorization.actor.role))throw fail('Rate review authorization changed',403);
   const Rate=forexRateModel(conn);
   const current=await Rate.findOne({
    _id:new Types.ObjectId(rateId),branchId:new Types.ObjectId(branchId),
    status:'pending_review',proposedBy:{$ne:new Types.ObjectId(authorization.actor.id)},
    expiresAt:{$gt:new Date()}
   }).session(session).lean();
   if(!current)throw fail('Rate expired, already reviewed, outside your branch or submitted by you',409);
   if(values.decision==='approve'){
    const branch=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'active'},{$inc:{revision:1}},{new:true,session}).lean();
    if(!branch)throw fail('Operating branch is unavailable',409);
    branchCurrency.resolve(branch,current.fromCurrency);
    branchCurrency.resolve(branch,current.toCurrency);
    const opposite=await Rate.findOne({branchId:current.branchId,
     fromCurrency:current.fromCurrency,toCurrency:current.toCurrency,
     side:current.side==='buy'?'sell':'buy',status:'active',expiresAt:{$gt:new Date()}
    }).session(session).lean();
    if(opposite&&(current.side==='buy'
      ?rateScaled(current.rateDecimal)>=rateScaled(opposite.rateDecimal)
      :rateScaled(current.rateDecimal)<=rateScaled(opposite.rateDecimal)))
      throw fail('Buy price must remain lower than Sell price for the same currencies',409);
    const newer=await Rate.exists({branchId:current.branchId,
      fromCurrency:current.fromCurrency,toCurrency:current.toCurrency,
      side:current.side,status:'active',createdAt:{$gt:current.createdAt}}).session(session);
    if(newer)throw fail('A newer rate is already approved',409);
    await Rate.updateMany({branchId:current.branchId,fromCurrency:current.fromCurrency,
      toCurrency:current.toCurrency,side:current.side,status:'active'},
      {$set:{status:'superseded'},$inc:{revision:1}},{session});
   }
   result=await Rate.findOneAndUpdate({_id:current._id,branchId:current.branchId,
    status:'pending_review',revision:current.revision,expiresAt:{$gt:new Date()}},
    {$set:{status:values.decision==='approve'?'active':'rejected',
      reviewedBy:authorization.actor.id,reviewedAt:new Date(),reviewNote:values.note},
     $inc:{revision:1}},{new:true,session}).lean();
   if(!result)throw fail('Rate changed while reviewing',409);
   await auditEventModel(conn).create([{
    action:values.decision==='approve'?'forex.rate.approved':'forex.rate.rejected',
    actorId:authorization.actor.id,targetId:result._id,
    metadata:{branchId:String(result.branchId),
      pair:result.fromCurrency+'/'+result.toCurrency,side:result.side,
      source:'mobile_money_currency_rates'}
   }],{session});
  });
  return result;
 }catch(error){
  if(error?.code===11000)throw fail('A newer rate was approved concurrently; refresh',409);
  throw error;
 }finally{await session.endSession();}
}
module.exports={proposal,decision,propose,review,MAKERS,REVIEWERS};
