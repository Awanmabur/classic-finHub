'use strict';
// Counts only, with no recipient addresses or message bodies in reports.
const {branchMatch}=require('../aggregateScope');
module.exports=Object.freeze({
 key:'notifications',label:'Notifications',moduleKey:'notifications',
 async rows({conn,dateRange,scope}){
  const {notificationMessageModel}=require('../../models');
  const match={createdAt:dateRange,...branchMatch(scope,String)};
  const results=await notificationMessageModel(conn).aggregate([{$match:match},
   {$group:{_id:{templateCode:'$templateCode',emailState:'$emailState'},count:{$sum:1}}},
   {$sort:{'_id.templateCode':1,'_id.emailState':1}},{$limit:5001}]);
  if(results.length>5000)throw Object.assign(new Error('Too many notification groups'),{status:422});
  return results.map(row=>({module:'Notifications',activity:String(row._id.templateCode),
   status:String(row._id.emailState),currency:'—',count:row.count,volume:'—',fees:'—'}));
 }
});
