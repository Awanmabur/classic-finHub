'use strict';
// Operational records only. Cash movement follows the physical drawer's immutable
// source amounts; commission is disclosed separately, never added to cash twice.
const {Types}=require('mongoose');
const {mobileTransactionModel,ensureTenantIndexes}=require('../models');
const mobile=require('./mobileMoney.service');
const {hasPermission}=require('./moduleAccess.service');
const {networks}=require('../../config/mobileNetworks');
const businessTime=require('../../utils/businessTime');
function fail(message,status=400){const error=new Error(message);error.status=status;return error;}
function objectId(value){if(!/^[a-f0-9]{24}$/i.test(String(value||'')))throw fail('An authorized record scope is required',403);return new Types.ObjectId(String(value));}
function readScope(actor){
 if(!actor?.id)throw fail('An authenticated staff account is required',403);
 if(['Tenant Owner','Auditor'].includes(actor.role))return require('./branchView.service').readScope(actor);
 return {...(actor.branchId?{branchId:objectId(actor.branchId)}:{}),
  ...(actor.role==='Mobile Money Operator'||!actor.branchId?{operatorId:objectId(actor.id)}:{})};
}
function canReport(actor){return hasPermission(actor,'mobile_money.report')||hasPermission(actor,'reports.view');}
function canExport(actor){return hasPermission(actor,'mobile_money.report')||hasPermission(actor,'reports.export');}
function scalar(input,key){const value=input[key];if(value===undefined||value===null||value==='')return '';if(typeof value!=='string')throw fail('Invalid Mobile Money filter');return value;}
function filters(input={},fixedOperation,timeZone='UTC'){
 const result={from:scalar(input,'from'),to:scalar(input,'to'),network:scalar(input,'network'),currency:scalar(input,'currency'),operation:fixedOperation||scalar(input,'operation'),entrySource:scalar(input,'entrySource')};
 if(result.network&&!networks.includes(result.network))throw fail('Choose a supported mobile money network');
 if(result.currency&&!Object.hasOwn(mobile.currencies,result.currency))throw fail('Choose a supported currency');
 if(result.operation&&!['cash_in','cash_out'].includes(result.operation))throw fail('Choose Deposit or Withdrawal');
 if(result.entrySource&&!['manual','sms'].includes(result.entrySource))throw fail('Choose manual entry or SMS capture');
 const bounds=mobile.dateBounds(result,timeZone);
 result.from=businessTime.localDay(bounds.$gte,timeZone);
 result.to=businessTime.localDay(new Date(bounds.$lt.getTime()-1),timeZone);
 return result;
}
function matchFor(actor,selected,timeZone='UTC'){
 return {...readScope(actor),createdAt:mobile.dateBounds(selected,timeZone),
  ...(selected.network?{network:selected.network}:{}),...(selected.currency?{currency:selected.currency}:{}),
  ...(selected.operation?{operation:selected.operation}:{}),
  ...(selected.entrySource==='manual'?{entrySource:{$in:['manual',null]}}:selected.entrySource?{entrySource:selected.entrySource}:{})};
}
function zero(currency){return {currency,count:0,voidedCount:0,cashInCount:0,cashOutCount:0,physicalCashInCount:0,physicalCashOutCount:0,cashInMinor:0n,cashOutMinor:0n,physicalCashInMinor:0n,physicalCashOutMinor:0n,volumeMinor:0n,feesMinor:0n,cashImpactMinor:0n};}
function serialize(row){
 const result={...row};for(const key of ['cashInMinor','cashOutMinor','physicalCashInMinor','physicalCashOutMinor','volumeMinor','feesMinor','cashImpactMinor'])if(key in result)result[key]=String(result[key]);
 result.formatted={};for(const [name,key] of Object.entries({cashIn:'cashInMinor',cashOut:'cashOutMinor',physicalCashIn:'physicalCashInMinor',physicalCashOut:'physicalCashOutMinor',volume:'volumeMinor',fees:'feesMinor',cashImpact:'cashImpactMinor'}))if(key in result)result.formatted[name]=mobile.formatMoneyMinor(result[key],row.currency);
 return result;
}
function summarize(groups){
 const currencies=new Map(),byNetwork=new Map(),physicalCurrencies=new Map();
 const summary={total:0,activeCount:0,voidedCount:0,manualCount:0,smsCount:0,byCurrency:[],cashByCurrency:[]};
 for(const group of groups){
  const {currency,network,operation,source,voided,paymentMethod='Cash'}=group._id,count=group.count;
  const cashCurrency=group._id.cashCurrency||currency;
  if(!Object.hasOwn(mobile.currencies,currency)||!Object.hasOwn(mobile.currencies,cashCurrency))throw fail('A record uses an unsupported currency; reconcile the source record before reporting',409);
  summary.total+=count;summary[source==='sms'?'smsCount':'manualCount']+=count;
  if(!currencies.has(currency))currencies.set(currency,zero(currency));
  const total=currencies.get(currency);
  if(voided){summary.voidedCount+=count;total.voidedCount+=count;continue;}
  summary.activeCount+=count;
  const key=`${network}:${currency}`;
  if(!byNetwork.has(key))byNetwork.set(key,{network,...zero(currency)});
  for(const row of [total,byNetwork.get(key)]){
   const amount=BigInt(String(group.amountMinor||0)),fee=BigInt(String(group.feeMinor||0));
   row.count+=count;row.volumeMinor+=amount;row.feesMinor+=fee;
   row[operation==='cash_in'?'cashInCount':'cashOutCount']+=count;
   row[operation==='cash_in'?'cashInMinor':'cashOutMinor']+=amount;
   // Provider transaction totals are ALWAYS in provider wallet currency.
   // Do not add actual SSP handed over against KES/UGX float to their
   // provider-currency cash totals.
   if(paymentMethod==='Cash'&&cashCurrency===currency){
    row[operation==='cash_in'?'physicalCashInCount':'physicalCashOutCount']+=count;
    row[operation==='cash_in'?'physicalCashInMinor':'physicalCashOutMinor']+=amount;
    row.cashImpactMinor+=group.cashMovementMinor==null?(operation==='cash_in'?amount:-amount):BigInt(String(group.cashMovementMinor));
   }
  }
  if(paymentMethod==='Cash'){
   if(!physicalCurrencies.has(cashCurrency))physicalCurrencies.set(cashCurrency,zero(cashCurrency));
   const cash=physicalCurrencies.get(cashCurrency);
   const delta=group.cashMovementMinor==null?
    (operation==='cash_in'?1n:-1n)*BigInt(String(group.amountMinor||'0')):
    BigInt(String(group.cashMovementMinor));
   // Signed native cash amount includes only what actually moved, not wallet
   // principal and not estimates of provider fees or commissions.
   cash.count+=count;
   cash[operation==='cash_in'?'physicalCashInCount':'physicalCashOutCount']+=count;
   cash[operation==='cash_in'?'physicalCashInMinor':'physicalCashOutMinor']+=delta<0n?-delta:delta;
   cash.cashImpactMinor+=delta;
  }
 }
 summary.cashByCurrency=[...physicalCurrencies.values()].sort((a,b)=>a.currency.localeCompare(b.currency)).map(serialize);
 summary.byCurrency=[...currencies.values()].sort((a,b)=>a.currency.localeCompare(b.currency)).map(serialize);
 return {summary,networks:[...byNetwork.values()].sort((a,b)=>a.network.localeCompare(b.network)||a.currency.localeCompare(b.currency)).map(serialize)};
}
async function workspace(conn,actor,input={},options={}){
 const timeZone=options.timeZone||businessTime.DEFAULT_TIME_ZONE;
 const selected=filters(input,options.operation,timeZone),match=matchFor(actor,selected,timeZone),position=mobile.decodeCursor(input.cursor);
 const requested=Number(options.limit??40),take=Number.isSafeInteger(requested)&&requested>=1&&requested<=100?requested:40;
 const query={...match};
 if(position)query.$or=[{createdAt:{$lt:position.at}},{createdAt:position.at,_id:{$lt:new Types.ObjectId(position.id)}}];
 await ensureTenantIndexes(conn);
 const Model=mobileTransactionModel(conn);
 const [groups,items]=await Promise.all([
  Model.aggregate([
   {$match:match},
   {$group:{
    _id:{currency:'$currency',network:'$network',operation:'$operation',source:{$ifNull:['$entrySource','manual']},paymentMethod:{$ifNull:['$paymentMethod','Cash']},voided:{$or:[{$eq:['$status','voided_internal']},{$eq:['$correctionState','voided']}] }},
    count:{$sum:1},amountMinor:{$sum:'$amountMinor'},feeMinor:{$sum:'$feeMinor'},
    cashMovementMinor:{$sum:{$ifNull:['$physicalCashMovementMinor',{$cond:[{$eq:['$operation','cash_in']},'$amountMinor',{$multiply:['$amountMinor',-1]}]}]}}
   }}
  ]),
  Model.find(query).sort({createdAt:-1,_id:-1}).limit(take+1).lean()
 ]);
 const visible=items.slice(0,take).map(row=>mobile.visibleRecordForRole(row,actor.role));
 return {filters:selected,...summarize(groups),records:{items:visible,nextCursor:items.length>take?mobile.encodeCursor(visible.at(-1)):null},
  networksAvailable:[...networks],currencies:Object.keys(mobile.currencies),formatMoneyMinor:mobile.formatMoneyMinor,
  canReport:canReport(actor),canExport:canExport(actor),cashImpactNote:'Cash impact is grouped by the real drawer currency, independently of provider float denomination. Only recorded actual physical cash movements count; estimated commissions, network charges, bank/wallet methods and internal voids are excluded. Provider settlement remains unverified.'};
}
function major(value,currency){const decimals=mobile.currencies[currency],n=BigInt(String(value)),absolute=n<0n?-n:n,base=10n**BigInt(decimals);return `${n<0n?'-':''}${absolute/base}${decimals?'.'+String(absolute%base).padStart(decimals,'0'):''}`;}
function toCsv(items,timeZone=businessTime.DEFAULT_TIME_ZONE){
 const rows=[['Date ('+timeZone+')','Operation','Customer','Customer phone','Customer ID / note','Network','Network reference','Currency','Amount','Recorded customer fee','Agent commission estimate (unreceived)','Agent sheet version','Provider customer charge estimate (not income)','Provider charge sheet version','Published agent commission reference (unapproved)','Published agent source checked on','Published customer network charge (not agent income)','Published customer source checked on','Payment method','Entry source','Internal record status','Internal review','Correction state','Risk signals','Provisional cash impact (native cash currency)','Actual cash currency']];
 for(const row of items){
  const voided=row.status==='voided_internal'||row.correctionState==='voided';
  rows.push([businessTime.format(row.createdAt,timeZone,true),row.operation,row.customer,row.customerPhone||'',row.customerNote||'',row.network,row.networkReference,row.currency,
   major(row.amountMinor,row.currency),major(row.feeMinor,row.currency),
   row.agentCommissionEstimate?major(row.agentCommissionEstimate.amountMinor,row.currency):'Not configured',
   row.agentCommissionEstimate?.version||'',
   row.customerNetworkFeeEstimate?major(row.customerNetworkFeeEstimate.amountMinor,row.currency):'Not configured',
   row.customerNetworkFeeEstimate?.version||'',
   row.agentCommissionPublishedReference?major(row.agentCommissionPublishedReference.amountMinor,row.currency):'',
   row.agentCommissionPublishedReference?.checkedOn||'',
   row.customerNetworkChargePublishedReference?major(row.customerNetworkChargePublishedReference.amountMinor,row.currency):'',
   row.customerNetworkChargePublishedReference?.checkedOn||'',
   row.paymentMethod||'Cash',row.entrySource||'manual',row.status,row.reviewState||'not_required',row.correctionState||'none',(row.riskSignals||[]).join(' | '),
   major(voided||(row.paymentMethod||'Cash')!=='Cash'?0n:(row.physicalCashMovementMinor==null?BigInt(String(row.amountMinor))*(row.operation==='cash_in'?1n:-1n):BigInt(String(row.physicalCashMovementMinor))),row.cashCurrency||row.currency),row.cashCurrency||row.currency]);
 }
 return rows.map(row=>row.map(mobile.csvCell).join(',')).join('\r\n')+'\r\n';
}
async function exportCsv(conn,actor,input={},timeZone=businessTime.DEFAULT_TIME_ZONE){
 if(!canExport(actor))throw fail('Mobile money report export permission is required',403);
 const selected=filters(input,undefined,timeZone),match=matchFor(actor,selected,timeZone),Model=mobileTransactionModel(conn);
 const count=await Model.countDocuments(match);
 if(count>5000)throw fail('Export contains more than 5,000 records. Narrow the dates or filters to export the complete result.',422);
 const items=await Model.find(match).sort({createdAt:-1,_id:-1}).limit(5001).lean();
 if(items.length>5000)throw fail('Export contains more than 5,000 records. Narrow the dates or filters to export the complete result.',422);
 return {csv:toCsv(items,timeZone),count:items.length,filters:selected};
}
module.exports={workspace,exportCsv,toCsv,summarize,filters,readScope,matchFor,canReport,canExport,networks,major};
