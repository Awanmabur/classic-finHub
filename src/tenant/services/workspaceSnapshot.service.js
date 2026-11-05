'use strict';
const mongoose=require('mongoose');
const {cashSessionModel}=require('../models');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const {formatMoneyMinor}=require('./mobileMoney.service');

async function snapshot(conn,tenant,user,data,operationBranch){
  const cash=[];let currentCashShift=null;
  if(operationBranch && hasModuleForUser(tenant,user,'mobile_money') && hasPermission(user,'mobile_money.view')){
    const scope={branchId:operationBranch._id,status:'open',openingVerifiedAt:{$ne:null}};
    if(user.role==='Mobile Money Operator')scope.operatorId=new mongoose.Types.ObjectId(user.id);
    const totals=await cashSessionModel(conn).aggregate([{$match:scope},{$group:{_id:'$currency',
      amount:{$sum:{$add:['$openingMinor','$provisionalMovementMinor']}},shiftCount:{$sum:1}}}]).option({maxTimeMS:2000});
    for(const total of totals)cash.push({currency:total._id,expectedFormatted:formatMoneyMinor(total.amount,total._id),shiftCount:total.shiftCount});
    if(['Tenant Owner','Mobile Money Operator'].includes(user.role)){
      const ownShift=await cashSessionModel(conn).findOne({branchId:operationBranch._id,operatorId:user.id,status:{$in:['open','disputed']}}).select('_id status currency').lean();
      if(ownShift)currentCashShift={id:String(ownShift._id),status:ownShift.status,currency:ownShift.currency,
        href:`/tenant/mobile-money/shifts/${ownShift._id}`,submitAction:`/tenant/mobile-money/shifts/${ownShift._id}/submit`};
    }
  }
  const recentActivity=[];
  if(data.hasMobileMoney)for(const row of data.summary?.recent||[])recentActivity.push({kind:'mobile_money',
    label:row.operation==='cash_in'?'Mobile money cash in':'Mobile money cash out',subtitle:`${row.network} · ${row.networkReference}`,
    amountLabel:formatMoneyMinor(row.amountMinor,row.currency),href:`/tenant/mobile-money/${row._id}/acknowledgement`,createdAt:row.createdAt,acknowledgement:true});
  const sources=[['hasTransfer','transferRecords','money-transfer','Transfer request'],['hasBanking','bankingRecords','banking','Banking request'],['hasForex','forexRecords','forex','Forex quote']];
  for(const [allowed,key,route,label] of sources)if(data[allowed])for(const row of data[key]?.items||[]){
    const amount=row.amountMinor ?? row.sourceAmountMinor;
    recentActivity.push({kind:route,label,subtitle:`${row.reference||''} · ${String(row.status||'').replaceAll('_',' ')}`,
      amountLabel:amount!=null&&row.currency?formatMoneyMinor(amount,row.currency):'',href:`/tenant/${route}/${row._id}`,createdAt:row.createdAt});
  }
  recentActivity.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const latest=recentActivity.filter(row=>row.acknowledgement)[0];
  return {cash,currentCashShift,cashBranchName:operationBranch?.name||null,recentActivity:recentActivity.slice(0,10),
    latestAcknowledgement:latest?{href:latest.href,label:'Last acknowledgement'}:null};
}
module.exports={snapshot};
