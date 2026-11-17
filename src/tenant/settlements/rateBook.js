'use strict';
// Select ONLY approved rates from the authenticated tenant database, never a
// client-submitted rate object. Existing quote-only legacy rates cannot settle.
const {forexRateModel}=require('../models');
const planner=require('./planner');
function loadApprovedRate(conn,session,criteria){
 const {rateId,branchId,fromCurrency,toCurrency,side,at=new Date()}=criteria||{};
 const _id=planner.objectId(rateId,'rate identifier');
 const branch=planner.objectId(branchId,'branch');
 planner.currency(fromCurrency);planner.currency(toCurrency);
 if(!['buy','sell'].includes(side))throw planner.fail('Approved Buy or Sell side is required',400);
 const when=new Date(at);if(!Number.isFinite(when.getTime()))throw planner.fail('Invalid price timestamp',400);
 const query={_id,branchId:branch,fromCurrency,toCurrency,side,status:'active',
  reviewedBy:{$ne:null},reviewedAt:{$ne:null},expiresAt:{$gt:when}};
 return forexRateModel(conn).findOne(query).session(session||null).lean()
  .then(rate=>{
   if(!rate)throw planner.fail('No valid approved Buy or Sell rate exists for this branch and currency pair');
   return {rate,snapshot:planner.rateSnapshot(rate,{branchId:branch,fromCurrency,toCurrency,side,at:when})};
  });
}
async function quoteMoMo(conn,session,{rateId,...params}){
 if(params?.channel!=='mobile_money')throw planner.fail('Only Mobile Money rate lookup is supported by this quote route',400);
 const side=params.operation==='cash_out'?'buy':params.operation==='cash_in'?'sell':null;
 if(!side)throw planner.fail('Invalid Mobile Money operation',400);
 const approved=await loadApprovedRate(conn,session,{
  rateId,branchId:params.branchId,fromCurrency:params.providerCurrency,toCurrency:params.cashCurrency,side,at:params.at
 });
 return planner.quote({...params,rate:approved.rate});
}
async function quoteTransfer(conn,session,{rateId,...params}){
 const approved=await loadApprovedRate(conn,session,{
  rateId,branchId:params.originBranchId,fromCurrency:params.payoutCurrency,
  toCurrency:params.collectionCurrency,side:'sell',at:params.at
 });
 return planner.transferPlan({...params,rate:approved.rate});
}
module.exports={loadApprovedRate,quoteMoMo,quoteTransfer};
