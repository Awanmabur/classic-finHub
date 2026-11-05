'use strict';
// Aggregate statuses only. Never expose request notes, authors or approvers.
module.exports=Object.freeze({
 key:'approval_workflows',label:'Approval Workflows',moduleKey:'approval_workflows',
 async rows({conn,dateRange,scope}){
  const {approvalRequestModel}=require('../../models');
  const match={createdAt:dateRange};if(scope.branchId)match.branchId=require('mongoose').Types.ObjectId.createFromHexString(scope.branchId);
  const results=await approvalRequestModel(conn).aggregate([{$match:match},
   {$group:{_id:{category:'$category',status:'$status'},count:{$sum:1}}},{$sort:{'_id.category':1,'_id.status':1}},{$limit:100}]);
  return results.map(r=>({module:'Approval Workflows',activity:String(r._id.category).replaceAll('_',' '),
   status:String(r._id.status),currency:'—',count:r.count,volume:'—',fees:'—'}));
 }
});
