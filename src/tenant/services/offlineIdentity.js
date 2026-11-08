'use strict';
const {createHash}=require('node:crypto');
// The credential version invalidates prepared pages as well as queued requests.
// This digest identifies a scope; it never authorizes a server operation.
module.exports=req=>({
 scope:createHash('sha256').update(`${req.tenant._id}:${req.user.id}:${req.user.authVersion||0}`).digest('hex'),
 branchId:String(req.operationBranch?._id||''),
 viewBranchId:req.viewBranchId||String(req.operationBranch?._id||'')
});
