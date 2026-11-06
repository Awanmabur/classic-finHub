'use strict';
// Dashboard figures are exact aggregates of the authorized database records.
// They describe recorded instructions/operations, never an external wallet balance.
const {Types}=require('mongoose');
const models=require('../models');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const {currencyCodes,currencyLabel}=require('../../config/currencies');
const mobile=require('./mobileMoney.service');
const sources=Object.freeze({
 money_transfer:{flag:'hasTransfer',model:'transferOrderModel',creator:'Money Transfer Operator',states:['requested','approved_pending_provider','collected_manual','paid_out_manual'],amount:'amountMinor',currency:'currency'},
 mobile_money:{flag:'hasMobileMoney',model:'mobileTransactionModel',creator:'Mobile Money Operator',states:['pending_verification','verified'],amount:'amountMinor',currency:'currency'},
 banking:{flag:'hasBanking',model:'bankingRequestModel',creator:'Banking Operator',states:['requested','approved_pending_bank','posted_manual'],amount:'amountMinor',currency:'currency'},
 forex:{flag:'hasForex',model:'forexQuoteModel',creator:'Forex Operator',states:['quoted','approved_pending_execution','posted_manual'],amount:'sourceMinor',currency:'fromCurrency'}
});
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function objectId(value){if(!/^[a-f0-9]{24}$/i.test(String(value||'')))throw fail('A valid account and branch scope are required',403);return new Types.ObjectId(String(value));}
function selectedCurrency(value,operationBranch){
 if(value!==undefined&&value!==null&&value!==''&&(typeof value!=='string'||!currencyCodes.includes(value)))throw fail('Choose a supported dashboard currency');
 const code=value||operationBranch?.currency||'UGX';
 if(!currencyCodes.includes(code))throw fail('The operating branch uses an unsupported currency',409);
 return code;
}
function scopeFor(user,key,operationBranch){
 const spec=sources[key];if(!spec)throw fail('Unknown dashboard source');
 const scope={};
 if(operationBranch){
  if(!['Tenant Owner','Auditor'].includes(user?.role)&&String(operationBranch._id)!==String(user?.branchId))throw fail('Dashboard branch assignment is unavailable',403);
  scope.branchId=objectId(operationBranch._id);
 }else if(!['Tenant Owner','Auditor'].includes(user?.role))scope.branchId=objectId(user?.branchId);
 if(user?.role===spec.creator)scope[key==='mobile_money'?'operatorId':'createdBy']=objectId(user.id);
 return scope;
}
function bounds(now=new Date()){
 if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw fail('Invalid dashboard date');
 const start=new Date(now);start.setUTCHours(0,0,0,0);return {$gte:start,$lt:new Date(start.getTime()+86400000)};
}
function activeMatch(user,key,operationBranch,now){
 const spec=sources[key];return {...scopeFor(user,key,operationBranch),createdAt:bounds(now),status:{$in:spec.states},
  ...(key==='mobile_money'?{correctionState:{$ne:'voided'}}:{})};
}
function money(value,currency){return mobile.formatMoneyMinor(value,currency).replace(/^[A-Z]{3}\s/,currencyLabel(currency)+' ');}
function totalFor(groups,currency){
 let total=0n,count=0;const states={};
 for(const group of groups){
  if(group._id.currency!==currency)continue;
  total+=BigInt(String(group.amountMinor??'0'));count+=group.count;
  states[group._id.status]=(states[group._id.status]||0)+group.count;
 }
 return {currency,amountMinor:String(total),formatted:money(total,currency),count,states};
}
function executionAmount(key,currency){
 if(key!=='forex')return {$toDecimal:'$sourceSnapshot.amountMinor'};
 const settlement={$cond:[{$eq:['$sourceSnapshot.operation','buy']},{$subtract:[{$toDecimal:'$sourceSnapshot.targetMinor'},{$toDecimal:'$sourceSnapshot.feeMinor'}]},{$add:[{$toDecimal:'$sourceSnapshot.targetMinor'},{$toDecimal:'$sourceSnapshot.feeMinor'}]}]};
 return {$cond:[{$eq:['$sourceSnapshot.fromCurrency',currency]},{$toDecimal:'$sourceSnapshot.sourceMinor'},settlement]};
}
function executionMatch(user,key,operationBranch,currency,now){
 return {...scopeFor(user,key,operationBranch),sourceType:key,status:'posted_manual',reviewedAt:bounds(now),
  ...(key==='forex'?{$or:[{'sourceSnapshot.fromCurrency':currency},{'sourceSnapshot.toCurrency':currency}]}:{'sourceSnapshot.currency':currency})};
}
async function volumes(conn,tenant,user,input={},operationBranch=null,overview={}){
 const currency=selectedCurrency(input.currency,operationBranch),now=input.now||new Date(),result={};
 await Promise.all(Object.entries(sources).map(async([key,spec])=>{
  if(overview[spec.flag]===false||!hasModuleForUser(tenant,user,key)||!hasPermission(user,`${key}.view`))return;
  const match=key==='mobile_money'?{...activeMatch(user,key,operationBranch,now),fundingState:'book_recorded'}:executionMatch(user,key,operationBranch,currency,now);
  const Model=key==='mobile_money'?models.mobileTransactionModel(conn):require('../funded/models').models(conn).execution;
  const grouped=await Model.aggregate([
   {$match:match},
   {$group:{_id:{currency:key==='mobile_money'?'$currency':{$literal:currency},status:'$status'},count:{$sum:1},amountMinor:{$sum:key==='mobile_money'?'$amountMinor':executionAmount(key,currency)}}}
  ]).option({maxTimeMS:2500});
  result[key]={...totalFor(grouped,currency),basis:key==='mobile_money'?'posted funds book movements':'independently reviewed posted manual movements'};
 }));
 return {selectedCurrency:currency,currencyOptions:currencyCodes.map(code=>({code,label:currencyLabel(code)})),todayVolumes:result,date:now.toISOString().slice(0,10)};
}
module.exports={volumes,sources,selectedCurrency,scopeFor,activeMatch,executionMatch,executionAmount,bounds,totalFor,money,fail};
