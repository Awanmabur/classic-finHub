'use strict';
// Read-only reconciliation of linked collection and payout evidence.
// A balanced internal journal is not proof of a physical handover or of an
// actual interbranch settlement. This module never moves or nets money.
const {models}=require('./models');
const core=require('../models');
const funded=require('../funded/models');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const {hasModuleForUser,hasPermission}=require('../services/moduleAccess.service');
const {formatMoneyMinor}=require('../services/mobileMoney.service');
const LIMIT=50;
function fail(message,status=403){return Object.assign(new Error(message),{status});}
function authorized(conn,tenant,actor,scope){
 if(!tenant?._id||!tenant.slug||conn?.name!==tenant.dbName||
  conn.name!==tenantDbNameFromSlug(tenant.slug))
  throw fail('Reconciliation is only available in the authenticated tenant database');
 if(!actor?.id||!['Tenant Owner','Branch Manager','Reconciliation Officer','Auditor'].includes(actor.role)||
  !hasModuleForUser(tenant,actor,'money_transfer')||!hasPermission(actor,'money_transfer.view'))
  throw fail('Transfer reconciliation requires an assigned supervisor or auditor');
 if(scope?.branchId){
  if(!/^[a-f0-9]{24}$/i.test(String(scope.branchId)))throw fail('Invalid scoped reconciliation branch');
 }else if(!['Tenant Owner','Auditor'].includes(actor.role))
  throw fail('A branch supervisor cannot inspect other branches');
 if(!['Tenant Owner','Auditor'].includes(actor.role)&&
  String(scope?.branchId||'')!==String(actor.branchId||''))
  throw fail('Branch reconciliation is restricted to the assigned branch');
}
function stateFor(row,order,pending,evidence){
 const sourceMatches=order&&String(order.amountMinor)===String(row.physicalCashMinor)&&
  String(order.payoutMinor)===String(row.providerPrincipalMinor)&&
  order.currency===row.cashCurrency&&order.payoutCurrency===row.providerCurrency&&
  String(order.destinationBranchId||order.branchId)===String(row.destinationBranchId||row.branchId);
 const stages=new Set(evidence);
 const issues=[];
 if(!sourceMatches)issues.push('Source and linked settlement disagree');
 if(!stages.has('cash_collected')||!row.cashAccountId||!row.postingBatchIds?.length)
  issues.push('Collection journal or evidence missing');
 if(row.status==='posted'){
  if(!stages.has('cash_paid')||!row.destinationPayoutAccountId||
     row.postingBatchIds?.length!==3||!row.postedAt||
     order?.status!=='paid_out_manual')
   issues.push('Verified recipient payout evidence or journal link missing');
 }else if(row.status==='collected'){
  if(stages.has('cash_paid')||row.destinationPayoutAccountId||order?.status!=='collected_manual')
   issues.push('Collection/payout lifecycle inconsistent');
 }
 if(row.status==='disputed')issues.push('Disputed: investigate before closing');
 const paid=row.status==='posted';
 const crossBranch=String(row.destinationBranchId||row.branchId)!==String(row.branchId);
 return {
  reference:row.sourceReference,sourceId:String(row.sourceId),
  collection:formatMoneyMinor(row.physicalCashMinor,row.cashCurrency),
  payout:formatMoneyMinor(row.providerPrincipalMinor,row.providerCurrency),
  sourceCurrency:row.cashCurrency,payoutCurrency:row.providerCurrency,
  status:row.status,
  stage:row.status==='collected'?
   pending?'Payout awaiting independent review':'Cash collected · payout outstanding':
   paid?'Payout posted in internal books':row.status.replaceAll('_',' '),
  branchState:paid&&crossBranch?
    'Cross-branch dues remain until independently reconciled':
   paid?'Same-branch currency position requires reconciliation':
    'No recipient cash payout recorded',
  verifiedProvider:row.providerState==='confirmed',
  needsReview:issues.length>0,
  issues,occurredAt:row.occurredAt||row.createdAt,
  postedAt:row.postedAt||null
 };
}
async function inspect(conn,tenant,actor,scope={}){
 authorized(conn,tenant,actor,scope);
 const branchId=scope.branchId||null;
 const match={tenantId:tenant._id,sourceModule:'money_transfer',
  ...(branchId?{$or:[{branchId},{destinationBranchId:branchId}]}:{})};
 const Linked=models(conn);
 const found=await Linked.settlement.find(match)
  .sort({occurredAt:-1,_id:-1}).limit(LIMIT+1).lean();
 const hasMore=found.length>LIMIT,rows=found.slice(0,LIMIT);
 if(!rows.length)return {items:[],hasMore:false,reviewCount:0,generatedAt:new Date()};
 const ids=rows.map(row=>row.sourceId),linkedIds=rows.map(row=>row._id);
 const [orders,payouts,events]=await Promise.all([
  core.transferOrderModel(conn).find({_id:{$in:ids}}).select('status amountMinor currency payoutMinor payoutCurrency branchId destinationBranchId').lean(),
  funded.models(conn).execution.find({sourceType:'money_transfer',action:'transfer_payout',
   sourceId:{$in:ids},status:'pending_review'}).select('sourceId').lean(),
  Linked.event.find({settlementId:{$in:linkedIds},stage:{$in:['cash_collected','cash_paid']}})
   .select('settlementId stage').lean()
 ]);
 const orderMap=new Map(orders.map(x=>[String(x._id),x]));
 const pendingSet=new Set(payouts.map(x=>String(x.sourceId)));
 const eventMap=new Map();
 for(const e of events){
  const id=String(e.settlementId),stages=eventMap.get(id)||[];
  stages.push(e.stage);eventMap.set(id,stages);
 }
 const items=rows.map(row=>stateFor(row,orderMap.get(String(row.sourceId)),
  pendingSet.has(String(row.sourceId)),eventMap.get(String(row._id))||[]));
 return {items,hasMore,reviewCount:items.filter(x=>x.needsReview).length,generatedAt:new Date()};
}
module.exports={inspect,authorized,stateFor,LIMIT};
