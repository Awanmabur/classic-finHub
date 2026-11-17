'use strict';
// A supervisor's READ-ONLY queue for collected transfers which have not paid
// the recipient. This never reverses funds, refunds customers, retries a
// provider transfer or changes an immutable original record.
const core=require('../models');
const funded=require('../funded/models');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const {hasModuleForUser,hasPermission}=require('../services/moduleAccess.service');
const {formatMoneyMinor}=require('../services/mobileMoney.service');
const LIMIT=50,ATTENTION_HOURS=24;
function fail(message,status=403){return Object.assign(new Error(message),{status});}
function assertScope(conn,tenant,actor,scope){
 if(!tenant?._id||!tenant.slug||conn?.name!==tenant.dbName||
   conn.name!==tenantDbNameFromSlug(tenant.slug))
  throw fail('Only the authenticated tenant can review its outstanding cash collections');
 if(!actor?.id||!['Tenant Owner','Branch Manager','Reconciliation Officer','Auditor'].includes(actor.role)||
   !hasModuleForUser(tenant,actor,'money_transfer')||!hasPermission(actor,'money_transfer.view'))
  throw fail('A transfer supervisor or auditor is required to view recovery cases');
 if(!scope||typeof scope!=='object'||Object.keys(scope).some(k=>k!=='branchId'))
  throw fail('Invalid financial branch scope');
 if(scope.branchId&&!/^[0-9a-f]{24}$/i.test(String(scope.branchId)))throw fail('Invalid financial branch ID');
 if(!['Tenant Owner','Auditor'].includes(actor.role)&&
  (!scope.branchId||String(scope.branchId)!==String(actor.branchId||'')))
  throw fail('Branch supervisors may only inspect their own assigned branch');
}
function classify(order,latest,now=new Date(),refundPending=false){
 if(!order||order.status!=='collected_manual')throw fail('Only actually collected, unpaid transfers can enter this queue',409);
 const since=order.manualPostedAt||order.createdAt;
 const age=since?Math.max(0,Math.floor((now-new Date(since))/3600000)):null;
 const state=latest?.status==='posted_manual'?'inconsistent_paid_status':
  refundPending&&latest?.status==='pending_review'?'conflicting_refund_and_payout':
  refundPending?'refund_under_review':
  latest?.status==='pending_review'?'awaiting_payout_review':
  latest?.status==='rejected'?'payout_rejected':'awaiting_recipient';
 const needsAttention=['payout_rejected','inconsistent_paid_status','refund_under_review','conflicting_refund_and_payout'].includes(state)||age===null||age>=ATTENTION_HOURS;
 return {
  sourceId:String(order._id),reference:order.reference,
  senderCollected:formatMoneyMinor(order.amountMinor,order.currency),
  recipientDue:formatMoneyMinor(order.payoutMinor||order.amountMinor,order.payoutCurrency||order.currency),
  state,needsAttention,hoursSinceCollection:age,
  // A failed payout attempt has NOT returned collected cash to the sender.
  // Original PIN verification can be retried; any refund needs its own
  // independently reviewed real-cash adjustment. The cash-only refund is separately gated.
  explanation:state==='inconsistent_paid_status'?
   'STOP. A payout execution appears posted but the transfer remains marked unpaid. Do not pay again or refund. Reconcile its journal and source status with an independent supervisor.':
   state==='conflicting_refund_and_payout'?
    'STOP. Both a recipient payout and sender refund await review. Finance must resolve the competing instructions; neither may be treated as paid until the original cash and PIN evidence is reconciled.':
   state==='refund_under_review'?
    'Sender cash refund requested, NOT yet approved or paid. Do not issue a recipient payout until the refund review is resolved. Confirm the real original-currency drawer and sender signed evidence.':
   state==='payout_rejected'?
   'Payout review rejected. No recipient cash was posted by that attempt. Re-check the original PIN and receiver identity before a new payout request; do not create a duplicate transfer.':
   state==='awaiting_payout_review'?
    'A payout request awaits independent finance review; recipient cash has not been posted.':
    'Sender cash has been collected, but no recipient payout request is awaiting review.',
  collectedAt:since||null
 };
}
async function list(conn,tenant,actor,scope={},now=new Date()){
 assertScope(conn,tenant,actor,scope);
 if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw fail('Invalid recovery review timestamp',400);
 const query={status:'collected_manual',...(scope.branchId?
  {$or:[{branchId:scope.branchId},{destinationBranchId:scope.branchId}]}:{})};
 const records=await core.transferOrderModel(conn).find(query)
  .select('_id reference currency amountMinor payoutCurrency payoutMinor status branchId destinationBranchId manualPostedAt createdAt')
  .sort({manualPostedAt:1,_id:1}).limit(LIMIT+1).lean();
 const hasMore=records.length>LIMIT,rows=records.slice(0,LIMIT);
 if(!rows.length)return {items:[],attentionCount:0,hasMore,attentionHours:ATTENTION_HOURS};
 const [attempts,pendingRefunds]=await Promise.all([funded.models(conn).execution.aggregate([
  {$match:{sourceType:'money_transfer',action:'transfer_payout',sourceId:{$in:rows.map(x=>x._id)}}},
  {$sort:{createdAt:-1,_id:-1}},
  {$group:{_id:'$sourceId',status:{$first:'$status'}}}
 ]),require('../refunds/models').model(conn).find({
  tenantId:tenant._id,sourceId:{$in:rows.map(x=>x._id)},status:'pending_review'
 }).select('sourceId').lean()]);
 const latest=new Map(attempts.map(x=>[String(x._id),x]));
 const refunds=new Set(pendingRefunds.map(x=>String(x.sourceId)));
 const items=rows.map(row=>classify(row,latest.get(String(row._id)),now,
  refunds.has(String(row._id))));
 return {items,attentionCount:items.filter(x=>x.needsAttention).length,
  hasMore,attentionHours:ATTENTION_HOURS};
}
module.exports={list,classify,assertScope,LIMIT,ATTENTION_HOURS};
