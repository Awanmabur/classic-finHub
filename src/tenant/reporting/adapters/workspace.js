'use strict';
// No user names, email addresses, PII or raw audit metadata leave this adapter.
module.exports=Object.freeze({
 key:'workspace',label:'Workspace activity',moduleKey:null,
 async rows({conn,dateRange,scope}){
  const {auditEventModel}=require('../../models');
  const query={createdAt:dateRange};
  if(scope.branchId)query['metadata.branchId']=scope.branchId;
  const items=await auditEventModel(conn).aggregate([{$match:query},{$group:{_id:'$action',count:{$sum:1}}},{$sort:{count:-1,_id:1}},{$limit:5001}]);
  if(items.length>5000){const e=new Error('Too many report groups. Narrow the date range.');e.status=422;throw e;}
  return items.map(r=>({module:'Workspace',activity:String(r._id).slice(0,120),status:'recorded',currency:'—',count:r.count,volume:'—',fees:'—'}));
 }
});
