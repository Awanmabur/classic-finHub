'use strict';
const mongoose=require('mongoose');
const {cashSessionModel,notificationMessageModel}=require('../models');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const {formatMoneyMinor}=require('./mobileMoney.service');
const volumeService=require('./dashboardVolumes.service');
const cashOperators=new Set(['Mobile Money Operator','Money Transfer Operator','Banking Operator','Forex Operator']);
const cashRoles=new Set(['Tenant Owner',...cashOperators,'Branch Manager','Reconciliation Officer','Auditor']);
const cashModules=['mobile_money','money_transfer','banking','forex','expenses'];
function recentRow(route,row){
 if(route==='mobile-money')return {kind:'mobile_money',label:`${row.operation==='cash_in'?'Deposit':'Withdrawal'} • ${row.customer}`,
  subtitle:`${row.networkReference} • ${row.customerPhone||row.network} • Cash ${row.operation==='cash_in'?'received':'paid'}: ${formatMoneyMinor(row.settlementAmountMinor??row.amountMinor,row.settlementCurrency||row.currency)}`,amountLabel:formatMoneyMinor(row.amountMinor,row.currency),
  href:`/tenant/mobile-money/${row._id}/acknowledgement`,createdAt:row.createdAt,status:(row.status||'pending_verification').replaceAll('_',' '),acknowledgement:true};
 const forex=route==='forex',amount=forex?row.sourceMinor:row.amountMinor,currency=forex?row.fromCurrency:row.currency;
 const label=forex?`${row.operation==='sell'?'Sell forex':row.operation==='buy'?'Buy forex':'Forex quote'} • ${row.customerLabel}`:
  route==='banking'?`${row.kind.replaceAll('_request','').replaceAll('_',' ')} • ${row.source.customerName}`:`Money transfer • ${row.beneficiary.name}`;
 return {kind:route,label,subtitle:row.reference||'',amountLabel:amount!=null&&currency?formatMoneyMinor(amount,currency):'',
  href:`/tenant/${route}/${row._id}${route==='money-transfer'?'/acknowledgement':''}`,createdAt:row.createdAt,status:String(row.status||'').replaceAll('_',' '),acknowledgement:route==='money-transfer'};
}
function activity(data){
 const recentActivity=[];
 if(data.hasMobileMoney)for(const row of data.summary?.recent||[])recentActivity.push(recentRow('mobile-money',row));
 const sources=[['hasTransfer','transferRecords','money-transfer'],['hasBanking','bankingRecords','banking'],['hasForex','forexRecords','forex']];
 for(const [allowed,key,route] of sources)if(data[allowed])for(const row of data[key]?.items||[])recentActivity.push(recentRow(route,row));
 recentActivity.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
 const latest=recentActivity.find(row=>row.acknowledgement);
 return {recentActivity:recentActivity.slice(0,14),latestAcknowledgement:latest?{href:latest.href,label:'Last receipt'}:null};
}
// Current approved book balances are unique custody assets, not cash-flow
// turnover, tenant equity, or realized Forex profit. Never add currencies.
async function operationalFunds(conn,user,operationBranch){
 if(!hasPermission(user,'treasury.view'))return [];
 let scope={};
 if(require('./branchView.service').canViewBranches(user)&&user.viewBranchId!==undefined)
  scope=require('./branchView.service').readScope(user);
 else if(operationBranch)scope={branchId:operationBranch._id};
 else if(!['Tenant Owner','Auditor'].includes(user.role))return [];
 if(cashOperators.has(user.role))scope.operatorId=new mongoose.Types.ObjectId(user.id);
 const accounts=require('../treasury/models').models(conn).account;
 const groups=await accounts.aggregate([
  {$match:{...scope,status:'active',openingApprovedAt:{$ne:null},reconciliationState:'matched',
    kind:{$in:['cash','wallet','bank','forex_stock']}}},
  {$group:{_id:{currency:'$currency',kind:'$kind',moduleKey:'$moduleKey'},
    amountMinor:{$sum:'$bookBalanceMinor'},accountCount:{$sum:1}}}
 ]).option({maxTimeMS:2500});
 const currencies=new Map();
 for(const row of groups){
  const code=row?._id?.currency;
  if(!require('../../config/currencies').currencyCodes.includes(code))continue;
  const amount=BigInt(String(row.amountMinor||'0'));
  const item=currencies.get(code)||{currency:code,amountMinor:0n,accounts:0,kinds:{},modules:{}};
  item.amountMinor+=amount;
  item.accounts+=row.accountCount;
  item.kinds[row._id.kind]=(item.kinds[row._id.kind]||0n)+amount;
  item.modules[row._id.moduleKey]=(item.modules[row._id.moduleKey]||0n)+amount;
  currencies.set(code,item);
 }
 return [...currencies.values()].sort((a,b)=>a.currency.localeCompare(b.currency)).map(item=>({
  currency:item.currency,amountMinor:String(item.amountMinor),
  formatted:formatMoneyMinor(item.amountMinor,item.currency),accountCount:item.accounts,
  kinds:Object.fromEntries(Object.entries(item.kinds).map(([k,v])=>[k,formatMoneyMinor(v,item.currency)])),
  modules:Object.fromEntries(Object.entries(item.modules).map(([k,v])=>[k,formatMoneyMinor(v,item.currency)]))
 }));
}
async function snapshot(conn,tenant,user,data,operationBranch,options={}){
 const cash=[];let currentCashShift=null,dayStatus=null,notificationUnread=null;
 const viewing=require('./branchView.service').canViewBranches(user)&&user.viewBranchId!==undefined;
 const viewedBranch=viewing?options.viewBranch:operationBranch;
 const selectedCurrency=volumeService.selectedCurrency(options.currency,viewedBranch||operationBranch);
 const canCash=(operationBranch||viewing)&&cashRoles.has(user.role)&&hasPermission(user,'treasury.view')&&
  cashModules.some(key=>hasModuleForUser(tenant,user,key))&&
  (['Tenant Owner','Auditor'].includes(user.role)||String(operationBranch._id)===String(user.branchId));
 const scope={...(viewing?require('./branchView.service').readScope(user):{branchId:operationBranch?._id}),status:{$in:['open','disputed']},openingVerifiedAt:{$ne:null}};
 if(canCash&&cashOperators.has(user.role))scope.operatorId=new mongoose.Types.ObjectId(user.id);
 const canOwnShift=canCash&&operationBranch&&(user.role==='Tenant Owner'||cashOperators.has(user.role));
 // These are independent read-only summaries; one slow network round trip must
 // not serialize cash, shift, inbox and volume reads.
 const [totals,ownShift,unread,volumeData,fundsByCurrency]=await Promise.all([
  canCash?cashSessionModel(conn).aggregate([{$match:scope},{$group:{_id:'$currency',amount:{$sum:{$add:['$openingMinor','$provisionalMovementMinor']}},shiftCount:{$sum:1}}}]).option({maxTimeMS:2000}):[],
  canOwnShift?cashSessionModel(conn).findOne({branchId:operationBranch._id,operatorId:user.id,currency:selectedCurrency}).select('_id status currency openingVerifiedAt').sort({createdAt:-1,_id:-1}).lean():null,
  hasModuleForUser(tenant,user,'notifications')&&hasPermission(user,'notifications.view')?notificationMessageModel(conn).countDocuments({recipientId:user.id,readAt:null}).maxTimeMS(2000):null,
  volumeService.volumes(conn,tenant,user,options,viewedBranch,data),
  operationalFunds(conn,user,viewedBranch||operationBranch)
 ]);
 notificationUnread=unread;
 if(canCash){
  for(const total of totals)cash.push({currency:total._id,expectedFormatted:formatMoneyMinor(total.amount,total._id),shiftCount:total.shiftCount});
  dayStatus=totals.some(total=>total._id===selectedCurrency)?'OPEN':null;
  if(ownShift){
   if(!viewing||String(viewedBranch?._id)===String(operationBranch._id))dayStatus=({open:'OPEN',disputed:'REVIEW',submitted:'REVIEW',pending_open:'PENDING',approved:'CLOSED',opening_rejected:'CLOSED'})[ownShift.status]||null;
   if(['open','disputed'].includes(ownShift.status)&&ownShift.openingVerifiedAt)currentCashShift={id:String(ownShift._id),status:ownShift.status,currency:ownShift.currency,href:`/tenant/cash/shifts/${ownShift._id}`,submitAction:`/tenant/cash/shifts/${ownShift._id}/submit`};
  }
 }
 return {...volumeData,fundsByCurrency,cash,currentCashShift,dayStatus,notificationUnread,terminalCode:viewedBranch?.code||(viewing?'ALL':null),
  cashBranchName:viewedBranch?.name||(viewing?'All branches':null),...activity(data)};
}
module.exports={snapshot,activity,recentRow,cashRoles,operationalFunds};
