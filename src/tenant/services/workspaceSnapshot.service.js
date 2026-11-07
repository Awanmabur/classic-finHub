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
 if(route==='mobile-money')return {kind:'mobile_money',label:`${row.operation==='cash_in'?'Cash-in':'Cash-out'} • ${row.customer}`,
  subtitle:`${row.networkReference} • ${row.customerPhone||row.network}`,amountLabel:formatMoneyMinor(row.amountMinor,row.currency),
  href:`/tenant/mobile-money/${row._id}/acknowledgement`,createdAt:row.createdAt,status:(row.status||'pending_verification').replaceAll('_',' '),acknowledgement:true};
 const forex=route==='forex',amount=forex?row.sourceMinor:row.amountMinor,currency=forex?row.fromCurrency:row.currency;
 const label=forex?`${row.operation==='sell'?'Sell forex':row.operation==='buy'?'Buy forex':'Forex quote'} • ${row.customerLabel}`:
  route==='banking'?`${row.kind.replaceAll('_request','').replaceAll('_',' ')} • ${row.source.customerName}`:`Money transfer • ${row.beneficiary.name}`;
 return {kind:route,label,subtitle:row.reference||'',amountLabel:amount!=null&&currency?formatMoneyMinor(amount,currency):'',
  href:`/tenant/${route}/${row._id}${route==='money-transfer'?'/acknowledgement':''}`,createdAt:row.createdAt,status:String(row.status||'').replaceAll('_',' '),acknowledgement:route==='money-transfer'};
}
async function snapshot(conn,tenant,user,data,operationBranch,options={}){
 const cash=[];let currentCashShift=null,dayStatus=null,notificationUnread=null;
 const viewing=require('./branchView.service').canViewBranches(user)&&user.viewBranchId!==undefined;
 const viewedBranch=viewing?options.viewBranch:operationBranch;
 const canCash=(operationBranch||viewing)&&cashRoles.has(user.role)&&hasPermission(user,'treasury.view')&&
  cashModules.some(key=>hasModuleForUser(tenant,user,key))&&
  (['Tenant Owner','Auditor'].includes(user.role)||String(operationBranch._id)===String(user.branchId));
 if(canCash){
  const scope={...(viewing?require('./branchView.service').readScope(user):{branchId:operationBranch._id}),status:{$in:['open','disputed']},openingVerifiedAt:{$ne:null}};
  if(cashOperators.has(user.role))scope.operatorId=new mongoose.Types.ObjectId(user.id);
  const totals=await cashSessionModel(conn).aggregate([{$match:scope},{$group:{_id:'$currency',
   amount:{$sum:{$add:['$openingMinor','$provisionalMovementMinor']}},shiftCount:{$sum:1}}}]).option({maxTimeMS:2000});
  for(const total of totals)cash.push({currency:total._id,expectedFormatted:formatMoneyMinor(total.amount,total._id),shiftCount:total.shiftCount});
  dayStatus=totals.length?'OPEN':null;
  if(operationBranch&&(user.role==='Tenant Owner'||cashOperators.has(user.role))){
   const ownShift=await cashSessionModel(conn).findOne({branchId:operationBranch._id,operatorId:user.id})
    .select('_id status currency openingVerifiedAt').sort({createdAt:-1,_id:-1}).lean();
   if(ownShift){
    if(!viewing||String(viewedBranch?._id)===String(operationBranch._id))dayStatus=({open:'OPEN',disputed:'REVIEW',submitted:'REVIEW',pending_open:'PENDING',approved:'CLOSED',opening_rejected:'CLOSED'})[ownShift.status]||null;
    if(['open','disputed'].includes(ownShift.status)&&ownShift.openingVerifiedAt)currentCashShift={id:String(ownShift._id),status:ownShift.status,currency:ownShift.currency,
     href:`/tenant/cash/shifts/${ownShift._id}`,submitAction:`/tenant/cash/shifts/${ownShift._id}/submit`};
   }
  }
 }
 if(hasModuleForUser(tenant,user,'notifications')&&hasPermission(user,'notifications.view'))notificationUnread=await notificationMessageModel(conn).countDocuments({recipientId:user.id,readAt:null}).maxTimeMS(2000);
 const recentActivity=[];
 if(data.hasMobileMoney)for(const row of data.summary?.recent||[])recentActivity.push(recentRow('mobile-money',row));
 const sources=[['hasTransfer','transferRecords','money-transfer'],['hasBanking','bankingRecords','banking'],['hasForex','forexRecords','forex']];
 for(const [allowed,key,route] of sources)if(data[allowed])for(const row of data[key]?.items||[])recentActivity.push(recentRow(route,row));
 recentActivity.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
 const latest=recentActivity.find(row=>row.acknowledgement);
 const volumeData=await volumeService.volumes(conn,tenant,user,options,viewedBranch,data);
 return {...volumeData,cash,currentCashShift,dayStatus,notificationUnread,terminalCode:viewedBranch?.code||(viewing?'ALL':null),
  cashBranchName:viewedBranch?.name||(viewing?'All branches':null),recentActivity:recentActivity.slice(0,14),
  latestAcknowledgement:latest?{href:latest.href,label:'Last receipt'}:null};
}
module.exports={snapshot,recentRow,cashRoles};
