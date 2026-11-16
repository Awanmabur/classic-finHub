'use strict';
const businessTime=require('../../utils/businessTime');
function fail(message){return Object.assign(new Error(message),{status:409});}
// Filter "all branches" using ONE calendar only when every active branch has
// the same named timezone. Multi-timezone summaries must be selected by branch,
// not silently cut at the operating branch's midnight.
async function forRequest(req){
 if(req?.user?.viewBranchId!=='all')return businessTime.forBranch(req.viewBranch||req.operationBranch);
 const branches=await require('../models').branchModel(req.tenantDb)
  .find({status:'active'}).select('currency timeZone').lean();
 const zones=[...new Set(branches.map(b=>businessTime.forBranch(b)))];
 if(zones.length>1)throw fail('These branches use different local business timezones. Select one branch in the dashboard header for accurate dated transactions and reports.');
 return zones[0]||businessTime.forBranch(req.operationBranch);
}
module.exports={forRequest};
