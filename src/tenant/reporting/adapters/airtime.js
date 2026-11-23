'use strict';
// Only real recorded stock purchases and manually confirmed airtime sales.
const {Types}=require('mongoose');
const {branchMatch}=require('../aggregateScope');
const {models}=require('../../retailFinance/airtime.models');
const fmt=require('../../services/mobileMoney.service').formatMoneyMinor;
async function rows({conn,scope,dateRange}){
 const branch=branchMatch(scope,id=>new Types.ObjectId(id));
 const operator=scope.operatorId?{createdBy:new Types.ObjectId(String(scope.operatorId))}:{};
 const M=models(conn);
 const data=await M.record.aggregate([
  {$match:{...branch,...operator,createdAt:dateRange}},
  {$group:{_id:{type:'$type',currency:'$currency',network:'$network'},
   count:{$sum:1},amount:{$sum:{$cond:[{$eq:['$type','sale']},'$retailMinor','$costMinor']}},
   profit:{$sum:'$profitMinor'}}},
  {$limit:301}
 ]).option({maxTimeMS:5000});
 const corrections=await M.correction.aggregate([
  {$match:{...branch,...operator,createdAt:dateRange}},
  {$group:{_id:{type:'$type',currency:'$currency'},count:{$sum:1},amount:{$sum:'$amountMinor'},profit:{$sum:'$profitMinor'}}},
  {$limit:301}
 ]).option({maxTimeMS:5000});
 if(data.length>300||corrections.length>300)
  throw Object.assign(new Error('Narrow your airtime report dates'),{status:422});
 return [
  ...data.map(r=>({module:'Airtime',activity:(r._id.type==='sale'?'Manually recorded delivered airtime':'Prepaid stock purchases')+' · '+r._id.network,
   status:'posted_manual',currency:r._id.currency,count:r.count,amountMinor:String(r.amount),
   volume:fmt(r.amount,r._id.currency),fees:r._id.type==='sale'?fmt(r.profit,r._id.currency)+' gross profit':'—'})),
  ...corrections.map(r=>({module:'Airtime',activity:r._id.type==='sale'?'Refunded airtime sales':'Refunded stock purchases',
   status:'refunded',currency:r._id.currency,count:r.count,
   amountMinor:String(-BigInt(String(r.amount))),volume:fmt(String(-BigInt(String(r.amount))),r._id.currency),
   fees:r._id.type==='sale'?fmt(String(-BigInt(String(r.profit))),r._id.currency)+' reversed gross profit':'—'}))
 ];
}
module.exports=Object.freeze({key:'airtime',label:'Airtime transactions',moduleKey:'airtime',rows});
