'use strict';
// A financial record's branch comes from server-authenticated operating context,
// never from a dropdown, query parameter or posted branch choice.
const {branchModel}=require('../tenant/models');
const oid=/^[a-f0-9]{24}$/i;
const mutations=[
 /^\/mobile-money\/cash-(?:in|out)$/,
 /^\/mobile-money\/shifts\/open$/,
 /^\/money-transfer\/(?:contacts|requests)$/,
 /^\/banking\/(?:accounts|requests)$/,
 /^\/forex\/(?:rates|quotes)$/
];
function createOperatingBranch({getBranchModel=branchModel}={}){
 return async function operatingBranch(req,res,next){
  try{
   const Branch=getBranchModel(req.tenantDb),owner=req.user?.role==='Tenant Owner';
   let active=null;
   if(!owner){
    active=await Branch.findOne({_id:req.user.branchId,status:'active'}).select('_id name currency').lean();
    if(!active)return res.status(403).send('Assigned branch is inactive. Contact your administrator.');
   }else{
    const stored=req.session.operatingBranchTenantId===String(req.tenant._id)?req.session.operatingBranchId:null;
    if(oid.test(String(stored||''))){
     active=await Branch.findOne({_id:stored,status:'active'}).select('_id name currency').lean();
     if(!active){delete req.session.operatingBranchId;delete req.session.operatingBranchTenantId;}
    }
    if(!active){
     const branches=await Branch.find({status:'active'}).select('_id name currency').limit(2).lean();
     if(branches.length===1)active=branches[0];
    }
   }
   req.operatingBranch=active;
   req.operatingBranchId=active?String(active._id):null;
   req.user.operatingBranchId=req.operatingBranchId;
   if(req.method==='POST'&&mutations.some(re=>re.test(req.path))){
    if(!active)return res.status(409).send('Activate your operating branch in Branch Management before recording transactions.');
    const provided=req.body?.branchId;
    if(provided!==undefined&&(typeof provided!=='string'||provided!==req.operatingBranchId))
     return res.status(403).send('Branch override rejected. This operation belongs to your verified working branch.');
    req.body.branchId=req.operatingBranchId;
   }
   next();
  }catch(error){next(error);}
 };
}
module.exports=createOperatingBranch();
module.exports.createOperatingBranch=createOperatingBranch;
