'use strict';
const {createHash}=require('node:crypto');
// The credential version invalidates prepared pages as well as queued requests.
// This digest identifies a scope; it never authorizes a server operation.
function identity(req){return{
 scope:createHash('sha256').update(`${req.tenant._id}:${req.user.id}:${req.user.authVersion||0}`).digest('hex'),
 branchId:String(req.operationBranch?._id||''),
 viewBranchId:req.viewBranchId||String(req.operationBranch?._id||'')
};}
identity.context=(req,phoneDefaults)=>({
 ...identity(req),phoneCountry:(phoneDefaults||require('../../utils/phoneCountry').defaults(req)).country,
 csrfToken:req.session.csrfToken,userName:req.user.name,tenantName:req.workspaceIdentity?.name||req.tenant.name,
 expiresAt:Date.now()+7*86400000
});
module.exports=identity;
