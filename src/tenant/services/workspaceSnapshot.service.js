'use strict';
const {notificationMessageModel}=require('../models');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const {formatMoneyMinor}=require('./mobileMoney.service');
const volumeService=require('./dashboardVolumes.service');
function recentRow(route,row){
 if(route==='mobile-money')return {kind:'mobile_money',label:`${row.operation==='cash_in'?'Deposit':'Withdrawal'} • ${row.customer}`,
  subtitle:`${row.networkReference} • ${row.customerPhone||row.network}`,amountLabel:formatMoneyMinor(row.amountMinor,row.currency),
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
async function snapshot(conn,tenant,user,data,operationBranch,options={}){
 const viewing=require('./branchView.service').canViewBranches(user)&&user.viewBranchId!==undefined;
 const viewedBranch=viewing?options.viewBranch:operationBranch;
 const [notificationUnread,volumeData]=await Promise.all([
  hasModuleForUser(tenant,user,'notifications')&&hasPermission(user,'notifications.view')?notificationMessageModel(conn).countDocuments({recipientId:user.id,readAt:null}).maxTimeMS(2000):null,
  volumeService.volumes(conn,tenant,user,options,viewedBranch,data)
 ]);
 return {...volumeData,notificationUnread};
}
module.exports={snapshot,activity,recentRow};
