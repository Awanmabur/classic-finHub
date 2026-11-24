'use strict';
// Dashboard figures are exact aggregates of the authorized database records.
// They describe recorded instructions/operations, never an external wallet balance.
const {Types}=require('mongoose');
const models=require('../models');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const {currencyCodes,currencyLabel}=require('../../config/currencies');
const mobile=require('./mobileMoney.service');
const businessTime=require('../../utils/businessTime');
const sources=Object.freeze({
 money_transfer:{flag:'hasTransfer',ownRoles:['Money Transfer Operator']},
 mobile_money:{flag:'hasMobileMoney',ownRoles:['Mobile Money Operator']},
 banking:{flag:'hasBanking',ownRoles:['Banking Operator']},
 forex:{flag:'hasForex',ownRoles:['Forex Operator','Banking Operator','Money Transfer Operator']}
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
 if(require('./branchView.service').canViewBranches(user)&&user.viewBranchId!==undefined){
  Object.assign(scope,require('./branchView.service').readScope(user));
 }else if(operationBranch){
  if(!['Tenant Owner','Auditor'].includes(user?.role)&&String(operationBranch._id)!==String(user?.branchId))throw fail('Dashboard branch assignment is unavailable',403);
  scope.branchId=objectId(operationBranch._id);
 }else if(!['Tenant Owner','Auditor'].includes(user?.role))scope.branchId=objectId(user?.branchId);
 if(spec.ownRoles.includes(user?.role))scope[key==='mobile_money'?'operatorId':'createdBy']=objectId(user.id);
 return scope;
}
function bounds(now=new Date(),timeZone='UTC'){
 if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw fail('Invalid dashboard date');
 const { $gte,$lt }=businessTime.dayBounds({},timeZone,90,now);
 return {$gte,$lt};
}
function mobileMatch(user,operationBranch,now,timeZone){
 return {...scopeFor(user,'mobile_money',operationBranch),createdAt:bounds(now,timeZone),
  status:{$in:['recorded','pending_verification','verified']},correctionState:{$ne:'voided'},fundingState:'book_recorded'};
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
const decimal=value=>({$convert:{input:value,to:'decimal',onError:null,onNull:null}});
function currencyLegs(primary,secondary,cross,linked){
 return {$cond:[cross,[{...primary,linked},{...secondary,linked}],[primary]]};
}
function hasOtherLeg(first,second){
 return {$and:[{$in:[second,currencyCodes]},{$ne:[first,second]}]};
}
function linkedForex(user,enabled,cross,actorField){
 if(!enabled)return false;
 return sources.forex.ownRoles.includes(user.role)?{$and:[cross,{$eq:[actorField,objectId(user.id)]}]}:cross;
}
function forexLegs(){
 const gross=decimal('$sourceSnapshot.targetMinor'),fee={$ifNull:[decimal('$sourceSnapshot.feeMinor'),0]};
 const settlement={$cond:[{$eq:['$sourceSnapshot.operation','buy']},{$subtract:[gross,fee]},{$add:[gross,fee]}]};
 return currencyLegs(
  {currency:'$sourceSnapshot.fromCurrency',amount:decimal('$sourceSnapshot.sourceMinor')},
  {currency:'$sourceSnapshot.toCurrency',amount:settlement},
  hasOtherLeg('$sourceSnapshot.fromCurrency','$sourceSnapshot.toCurrency'),false
 );
}
async function aggregateLegs(Model,match,legs,{receipt='$_id',network=null,status='$status'}={}){
 // Reduce collection and payout records to one receipt per currency before
 // aggregating. The count facet ignores currency and cross-module copies.
 const [result]=await Model.aggregate([
  {$match:match},{$project:{receipt,network,status,legs}},{$unwind:'$legs'},
  {$match:{$expr:{$and:[{$in:['$legs.currency',currencyCodes]},{$gt:['$legs.amount',0]}]}}},
  {$group:{_id:{receipt:'$receipt',currency:'$legs.currency',network:'$network',status:'$status'},
   amountMinor:{$max:'$legs.amount'},linked:{$max:{$cond:['$legs.linked',1,0]}}}},
  {$facet:{
   byCurrency:[{$group:{_id:{currency:'$_id.currency',network:'$_id.network',status:'$_id.status',linked:'$linked'},
    count:{$sum:1},amountMinor:{$sum:'$amountMinor'}}}],
   receipts:[{$group:{_id:'$_id.receipt'}},{$count:'count'}]
  }}
 ]).option({maxTimeMS:2500,allowDiskUse:true});
 return {groups:result?.byCurrency||[],count:result?.receipts?.[0]?.count||0};
}
function nativeSource(conn,user,key,operationBranch,now,timeZone,forexEnabled){
 if(key==='mobile_money'){
  const cross=hasOtherLeg('$currency','$cashCurrency');
  const legs=currencyLegs(
   {currency:'$currency',amount:'$amountMinor'},
   {currency:'$cashCurrency',amount:'$cashAmountMinor'},
   cross,linkedForex(user,forexEnabled,cross,'$operatorId')
  );
  return aggregateLegs(models.mobileTransactionModel(conn),mobileMatch(user,operationBranch,now,timeZone),legs,{network:'$network'});
 }
 const Model=require('../funded/models').models(conn).execution;
 const match={...scopeFor(user,key,operationBranch),sourceType:key,status:'posted_manual',reviewedAt:bounds(now,timeZone)};
 // Module-linked Forex copies are attributed from the source posting below.
 // Count native trades here, including older snapshots without an origin.
 if(key==='forex')return aggregateLegs(Model,{...match,'sourceSnapshot.originRecordId':null},forexLegs(),{receipt:'$sourceId'});
 const primary={currency:'$sourceSnapshot.currency',amount:decimal('$sourceSnapshot.amountMinor')};
 if(key==='banking')return aggregateLegs(Model,match,[primary],{receipt:'$sourceId'});
 const cross={$and:[{$eq:['$action','transfer_payout']},hasOtherLeg('$sourceSnapshot.currency','$payoutFx.targetCurrency')]};
 return aggregateLegs(Model,match,currencyLegs(primary,
  {currency:'$payoutFx.targetCurrency',amount:'$payoutFx.payoutMinor'},cross,linkedForex(user,forexEnabled,cross,'$createdBy')
 ),{receipt:'$sourceId'});
}
function internalBanking(conn,tenant,user,operationBranch,now,timeZone,forexEnabled){
 const Model=require('../schemas/BankingInternalFx.schema').model(conn);
 const cross=hasOtherLeg('$sourceCurrency','$destinationCurrency');
 return aggregateLegs(Model,{...scopeFor(user,'banking',operationBranch),tenantId:objectId(tenant._id),
  state:'posted_internal',postedAt:bounds(now,timeZone)
 },currencyLegs({currency:'$sourceCurrency',amount:'$sourceAmountMinor'},
  {currency:'$destinationCurrency',amount:'$destinationAmountMinor'},cross,linkedForex(user,forexEnabled,cross,'$createdBy')
 ),{status:{$literal:'posted_manual'}});
}
async function readSource(key,read){
 try{return {...await read(),available:true};}
 catch(error){
  console.warn(JSON.stringify({event:'dashboard.currency_breakdown_unavailable',module:key,code:String(error.code||error.name||'UNKNOWN').slice(0,80)}));
  return {groups:[],count:0,available:false};
 }
}
async function volumes(conn,tenant,user,input={},operationBranch=null,overview={}){
 const currency=selectedCurrency(input.currency,operationBranch),now=input.now||new Date(),
  timeZone=input.timeZone||'UTC',result={},todayByCurrency={},todayByCurrencyUnavailable={};
 const countCurrency=Object.hasOwn(input,'totalsCurrency')?input.totalsCurrency:input.currency;
 if(input.suppressTodayVolumes===true)return {selectedCurrency:currency,currencyOptions:currencyCodes.map(code=>({code,label:currencyLabel(code)})),
  todayVolumes:{},todayByCurrency:{},todayByCurrencyUnavailable:{},todayTransactionCount:null,date:businessTime.localDay(now,timeZone),mixedRegion:true};
 const enabled=Object.keys(sources).filter(key=>overview[sources[key].flag]!==false&&
  hasModuleForUser(tenant,user,key)&&hasPermission(user,`${key}.view`));
 const forexEnabled=enabled.includes('forex');
 const jobs=enabled.map(key=>[key,()=>nativeSource(conn,user,key,operationBranch,now,timeZone,forexEnabled)]);
 if(enabled.includes('banking')&&hasModuleForUser(tenant,user,'accounts')&&hasPermission(user,'accounts.view'))
  jobs.push(['banking',()=>internalBanking(conn,tenant,user,operationBranch,now,timeZone,forexEnabled)]);
 const parts=await Promise.all(jobs.map(async([key,read])=>[key,await readSource(key,read)]));
 const todayTransactionCount=parts.length&&parts.every(([,data])=>data.available)
  ?parts.reduce((count,[,data])=>count+(countCurrency
   ?totalFor(data.groups,countCurrency).count:data.count),0):null;
 for(const key of enabled){
  const own=parts.filter(([source])=>source===key);
  const groups=own.flatMap(([,data])=>data.groups);
  if(key==='forex')for(const [source,data] of parts){
   if(source!==key)groups.push(...data.groups.filter(group=>group._id.linked===1));
  }
  if((key==='forex'?parts:own).some(([,data])=>!data.available))todayByCurrencyUnavailable[key]=true;
  todayByCurrency[key]=currencyCodes.map(code=>totalFor(groups,code)).filter(row=>row.count>0);
  const market=key==='mobile_money'?input.mobileMarket:null;
  const effectiveCurrency=market?.currency||currency;
  const selected=market?.network?groups.filter(group=>group._id.network===market.network):groups;
  result[key]={...totalFor(selected,effectiveCurrency),basis:'posted funds book movements',
   ...(market?{network:market.network,networkLabel:market.label}:{})};
 }
 return {selectedCurrency:currency,currencyOptions:currencyCodes.map(code=>({code,label:currencyLabel(code)})),todayVolumes:result,todayByCurrency,todayByCurrencyUnavailable,todayTransactionCount,date:businessTime.localDay(now,timeZone)};
}
module.exports={volumes,sources,selectedCurrency,scopeFor,bounds,totalFor,money,fail};
