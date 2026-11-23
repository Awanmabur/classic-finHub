'use strict';
// Tenant-scoped Forex activity: quotation history and finalized Treasury
// executions remain distinct evidence groups. Never add quotes to traded cash
// turnover or treat the spread as measured trading profit.
const {Types}=require('mongoose');
const fmt=require('../../services/mobileMoney.service').formatMoneyMinor;
const {models}=require('../../funded/models');
const {branchMatch}=require('../aggregateScope');
const limit=500;
module.exports=Object.freeze({
 key:'forex',label:'Forex quotations and finalized exchanges',moduleKey:'forex',
 async rows({conn,filters,scope,dateRange}){
  const quoteRows=await require('../../services/forex.service').reportRows({conn,filters,scope,dateRange});
  const match={
   sourceType:'forex',action:'forex',status:'posted_manual',reviewedAt:dateRange,
   ...branchMatch(scope,id=>new Types.ObjectId(id)),
   ...(scope.operatorId?{createdBy:new Types.ObjectId(String(scope.operatorId))}:{})
  };
  const groups=await models(conn).execution.aggregate([
   {$match:match},
   {$group:{_id:{operation:'$sourceSnapshot.operation',from:'$sourceSnapshot.fromCurrency',to:'$sourceSnapshot.toCurrency'},
    count:{$sum:1},
    source:{$sum:{$convert:{input:'$sourceSnapshot.sourceMinor',to:'decimal',onError:0,onNull:0}}},
    target:{$sum:{$convert:{input:'$sourceSnapshot.targetMinor',to:'decimal',onError:0,onNull:0}}}}},
   {$sort:{'_id.operation':1,'_id.from':1,'_id.to':1}},
   {$limit:limit+1}
  ]).option({maxTimeMS:8000});
  if(groups.length>limit)throw Object.assign(new Error('Narrow Forex reporting dates'),{status:422});
  return [...quoteRows,...groups.map(row=>({
   module:'Forex',
   activity:`Final ${row._id.operation==='buy'?'buy':'sell'} · ${row._id.from} → ${row._id.to} · Treasury posted`,
   status:'final',currency:row._id.from,count:row.count,
   amountMinor:String(row.source),targetCurrency:row._id.to,targetAmountMinor:String(row.target),
   volume:fmt(String(row.source),row._id.from),fees:'—'
  }))];
 }
});