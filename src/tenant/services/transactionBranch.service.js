'use strict';
// Transaction location is an account/device property, never a client form choice.
const OBJECT_ID=/^[a-f0-9]{24}$/i;
function fail(message,status=409){return Object.assign(new Error(message),{status});}
function assignedBranchId(actor,input={}){
  if(actor?.branchId && actor?.transactionBranchId && String(actor.branchId)!==String(actor.transactionBranchId))
    throw fail('The operating branch context no longer matches your account assignment.',403);
  const branchId=String(actor?.transactionBranchId || actor?.branchId || '');
  if(!OBJECT_ID.test(branchId))throw fail(actor?.role==='Tenant Owner'
    ? 'Set your operating branch in Branch Management before recording transactions.'
    : 'An active branch assignment is required. Contact your tenant owner.',actor?.role==='Tenant Owner'?409:403);
  const submitted=input?.branchId;
  if(submitted!==undefined && submitted!==null && submitted!=='' && String(submitted)!==branchId)
    throw fail('The submitted branch does not match your account assignment.',403);
  return branchId;
}
async function resolveTransactionBranch(conn,actor,input={},options={}){
  const Branch=options.Branch || require('../models').branchModel(conn);
  let branchId=String(actor?.transactionBranchId || actor?.branchId || '');
  let branch;
  if(branchId){
    assignedBranchId(actor,input);
    branch=await Branch.findOne({_id:branchId,status:'active'}).lean();
    if(!branch)throw fail('Your operating branch is inactive or unavailable. Update your account assignment before recording transactions.',403);
  }else{
    if(actor?.role!=='Tenant Owner')throw fail('An active branch assignment is required. Contact your tenant owner.',403);
    const available=await Branch.find({status:'active'}).sort({_id:1}).limit(2).lean();
    if(!available.length)throw fail('Create an active branch in Branch Management before recording transactions.');
    if(available.length!==1)throw fail('Your account needs an operating branch. Set it in Branch Management; transaction forms do not choose a branch.');
    branch=available[0];branchId=String(branch._id);
    assignedBranchId({...actor,transactionBranchId:branchId},input);
  }
  return branch;
}
async function requestContext(req,res,next){
  try{
    req.operationBranch=null;req.operationBranchError=null;
    try{
      req.operationBranch=await resolveTransactionBranch(req.tenantDb,req.user);
      req.user.transactionBranchId=String(req.operationBranch._id);
    }catch(error){
      if(![403,409].includes(error.status))throw error;
      // Reports, review and administration remain accessible without an operating
      // assignment. Creation services independently require a resolved branch.
      req.operationBranchError=error.message;
    }
    res.locals.operationBranch=req.operationBranch;
    res.locals.operationBranchError=req.operationBranchError;
    next();
  }catch(error){next(error);}
}
module.exports={assignedBranchId,resolveTransactionBranch,requestContext,fail};
