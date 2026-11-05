'use strict';
const mongoose=require('mongoose');
const Tenant=require('../../platform/models/Tenant');
const {limitsFor}=require('../../platform/services/commercial.service');
const {getTenantConnection}=require('../../config/mongo');
const {branchModel,tenantUserModel,staffInviteModel,mobileTransactionModel,ledgerJournalModel,financialOperationModel,auditEventModel,ensureTenantIndexes}=require('../models');
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
function requireOwner(actor){if(actor?.role!=='Tenant Owner')throw fail('Only tenant owners can manage branches',403);}
function validId(value){if(!/^[a-f0-9]{24}$/i.test(String(value||'')))throw fail('Invalid branch',400);return value;}
function validate(input,create=false){
  const name=String(input?.name||'').trim(),address=String(input?.address||'').trim();
  const code=String(input?.code||'').trim().toLowerCase();
  if(name.length<2||name.length>100||address.length>240)throw fail('Branch name must be 2–100 characters; address at most 240');
  if(create&&(!/^[a-z0-9][a-z0-9-]{1,30}$/.test(code)||!['UGX','KES'].includes(input?.currency))) throw fail('Invalid branch code or currency');
  return {name,address,...(create?{code,currency:input.currency}:{})};
}
async function list(tenant){const conn=getTenantConnection(tenant.slug);await ensureTenantIndexes(conn);return branchModel(conn).find({}).sort({status:1,name:1}).limit(500).lean();}
async function create(tenant,actor,input){
  requireOwner(actor);const values=validate(input,true);
  const conn=getTenantConnection(tenant.slug);await ensureTenantIndexes(conn);
  const limits=limitsFor(tenant);if(!limits)throw fail('Subscription inactive or expired',403);
  const session=await mongoose.startSession();let created;
  try{await session.withTransaction(async()=>{
    const reserved=await Tenant.findOneAndUpdate({_id:tenant._id,$or:[{branchCount:{$lt:limits.branches}},{branchCount:{$exists:false}}]},{$inc:{branchCount:1}},{session,new:true});
    if(!reserved)throw fail('Your subscription has reached its active branch limit',409);
    [created]=await branchModel(conn).create([{...values,createdBy:actor.id,updatedBy:actor.id}],{session});
    await auditEventModel(conn).create([{action:'branch.created',actorId:actor.id,targetId:created._id,metadata:{code:values.code,currency:values.currency}}],{session});
  });return created;
  }catch(e){if(e.code===11000)throw fail('A branch with this code already exists',409);throw e;}finally{await session.endSession();}
}
async function update(tenant,actor,branchId,input){
  requireOwner(actor);validId(branchId);const values=validate(input);
  const conn=getTenantConnection(tenant.slug);await ensureTenantIndexes(conn);
  const session=await mongoose.startSession();let updated;
  try{await session.withTransaction(async()=>{
    updated=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'active'},{$set:{...values,updatedBy:actor.id},$inc:{revision:1}},{session,new:true});
    if(!updated)throw fail('Branch not found or archived',404);
    await auditEventModel(conn).create([{action:'branch.updated',actorId:actor.id,targetId:updated._id,metadata:{name:updated.name,address:updated.address}}],{session});
  });return updated;
  }finally{await session.endSession();}
}
async function archive(tenant,actor,branchId){
  requireOwner(actor);validId(branchId);const conn=getTenantConnection(tenant.slug);await ensureTenantIndexes(conn);
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    const Branch=branchModel(conn),Users=tenantUserModel(conn),Invites=staffInviteModel(conn),Transactions=mobileTransactionModel(conn);
    const branch=await Branch.findOne({_id:branchId,status:'active'}).session(session);
    if(!branch)throw fail('Active branch not found',404);
    // Touch the branch document so simultaneous assignments and status edits conflict.
    const activePeople=await Users.exists({branchId:String(branchId),status:'active'}).session(session);
    const invitations=await Invites.exists({branchId:String(branchId),status:'pending',expiresAt:{$gt:new Date()}}).session(session);
    const pending=await Transactions.exists({branchId:branch._id,status:'pending_verification'}).session(session);
    const shifts=await require('../models').cashSessionModel(conn).exists({branchId:branch._id,status:{$ne:'approved'}}).session(session);
    // Conservative financial policy: once a branch has any posted ledger
    // history it must stay identifiable and addressable, even when reversed.
    const ledgerHistory=await ledgerJournalModel(conn).exists({branchId:branch._id}).session(session);
    const financialHistory=await financialOperationModel(conn).exists({branchId:branch._id}).session(session);
    const transferHistory=await require('../models').transferOrderModel(conn).exists({branchId:branch._id}).session(session);
    const bankingHistory=await require('../models').bankingRequestModel(conn).exists({branchId:branch._id}).session(session);
    const forexRateHistory=await require('../models').forexRateModel(conn).exists({branchId:branch._id}).session(session);
    const approvalPending=await require('../models').approvalRequestModel(conn).exists({branchId:branch._id,status:'pending'}).session(session);
    const forexQuoteHistory=await require('../models').forexQuoteModel(conn).exists({branchId:branch._id}).session(session);
    if(activePeople||invitations||pending||shifts||ledgerHistory||financialHistory||transferHistory||bankingHistory||forexRateHistory||forexQuoteHistory||approvalPending)
      throw fail('Reassign staff, resolve pending records and retain branches with financial operation or ledger history',409);
    const changed=await Branch.updateOne({_id:branchId,status:'active'},{$set:{status:'archived',updatedBy:actor.id},$inc:{revision:1}},{session});
    if(changed.modifiedCount!==1)throw fail('Concurrent change: retry',409);
    await Tenant.updateOne({_id:tenant._id,branchCount:{$gt:0}},{$inc:{branchCount:-1}},{session});
    await auditEventModel(conn).create([{action:'branch.archived',actorId:actor.id,targetId:branch._id,metadata:{code:branch.code}}],{session});
  });}finally{await session.endSession();}
}
async function restore(tenant,actor,branchId){
  requireOwner(actor);validId(branchId);const conn=getTenantConnection(tenant.slug);await ensureTenantIndexes(conn);
  const limits=limitsFor(tenant);if(!limits)throw fail('Subscription inactive or expired',403);
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    const reserved=await Tenant.findOneAndUpdate({_id:tenant._id,$or:[{branchCount:{$lt:limits.branches}},{branchCount:{$exists:false}}]},{$inc:{branchCount:1}},{session,new:true});
    if(!reserved)throw fail('Branch limit reached',409);
    const changed=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'archived'},{$set:{status:'active',updatedBy:actor.id},$inc:{revision:1}},{session,new:true});
    if(!changed)throw fail('Archived branch not found',404);
    await auditEventModel(conn).create([{action:'branch.restored',actorId:actor.id,targetId:changed._id,metadata:{code:changed.code}}],{session});
  });}finally{await session.endSession();}
}
module.exports={validate,create,list,update,archive,restore,validId};
