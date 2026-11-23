'use strict';
// Aggregate only: never expose borrower identity or contact details in Reports.
const {Types}=require('mongoose');
const {branchMatch}=require('../aggregateScope');
const {models}=require('../../retailFinance/loans.models');
const fmt=require('../../services/mobileMoney.service').formatMoneyMinor;
const MAX=150;
async function rows({conn,scope,dateRange}){
 const branch=branchMatch(scope,id=>new Types.ObjectId(id)),L=models(conn);
 const operator=scope.operatorId?new Types.ObjectId(String(scope.operatorId)):null;
 const requested=L.loan.aggregate([
  {$match:{...branch,...(operator?{requestedBy:operator}:{}),createdAt:dateRange}},
  {$group:{_id:{currency:'$currency',status:'$status'},count:{$sum:1},principal:{$sum:'$principalMinor'}}},
  {$limit:MAX+1}
 ]).option({maxTimeMS:5000});
 const disbursed=L.loan.aggregate([
  {$match:{...branch,...(operator?{disbursedBy:operator}:{}),disbursedAt:dateRange,status:{$in:['active','paid']}}},
  {$group:{_id:'$currency',count:{$sum:1},principal:{$sum:'$principalMinor'}}},
  {$limit:MAX+1}
 ]).option({maxTimeMS:5000});
 const repaid=L.payment.aggregate([
  {$match:{...branch,...(operator?{createdBy:operator}:{}),createdAt:dateRange}},
  {$group:{_id:'$currency',count:{$sum:1},amount:{$sum:'$amountMinor'},
    principal:{$sum:'$principalMinor'},interest:{$sum:'$interestMinor'}}},
  {$limit:MAX+1}
 ]).option({maxTimeMS:5000});
 const corrections=L.correction.aggregate([
  {$match:{...branch,...(operator?{createdBy:operator}:{}),createdAt:dateRange}},
  {$group:{_id:'$currency',count:{$sum:1},amount:{$sum:'$amountMinor'},principal:{$sum:'$principalMinor'},interest:{$sum:'$interestMinor'}}},
  {$limit:MAX+1}
 ]).option({maxTimeMS:5000});
 const [applications,loans,payments,reversed]=await Promise.all([requested,disbursed,repaid,corrections]);
 if([applications,loans,payments,reversed].some(x=>x.length>MAX))throw Object.assign(new Error('Narrow your loan reporting dates'),{status:422});
 return [
  ...applications.map(row=>({module:'Loan Management',activity:'Applications',status:row._id.status,
   currency:row._id.currency,count:row.count,amountMinor:String(row.principal),volume:fmt(row.principal,row._id.currency),
   fees:'—'})),
  ...loans.map(row=>({module:'Loan Management',activity:'Disbursed principal',status:'posted',currency:row._id,
   count:row.count,amountMinor:String(row.principal),volume:fmt(row.principal,row._id),fees:'—'})),
  ...payments.map(row=>({module:'Loan Management',activity:'Received repayments (principal + collected interest)',
   status:'posted',currency:row._id,count:row.count,amountMinor:String(row.amount),
   volume:fmt(row.amount,row._id),fees:fmt(row.interest,row._id)+' collected interest'})),
  ...reversed.map(row=>({module:'Loan Management',activity:'Reversed loan repayment',
   status:'refunded',currency:row._id,count:row.count,amountMinor:String(-BigInt(String(row.amount))),
   volume:fmt(String(-BigInt(String(row.amount))),row._id),
   fees:fmt(String(-BigInt(String(row.interest))),row._id)+' interest reversal'}))
 ];
}
module.exports=Object.freeze({key:'loans',label:'Loan Management',moduleKey:'loans',rows});
