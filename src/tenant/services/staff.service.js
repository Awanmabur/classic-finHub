const crypto = require('crypto');
const mongoose = require('mongoose');
const Tenant = require('../../platform/models/Tenant');
const AccountIdentity = require('../../platform/models/AccountIdentity');
const {limitsFor}=require('../../platform/services/commercial.service');
const { INVITABLE, permissionsFor } = require('../../config/roles');
const policy = require('./staffPolicy');
const { validateAssignments } = require('./moduleAccess.service');
const { branchModel } = require('../models');
const { staffInviteModel, tenantUserModel, auditEventModel, ensureTenantIndexes } = require('../models');
const { getTenantConnection } = require('../../config/mongo');
const { validatePassword } = require('../../platform/services/authentication.service');
const { appUrl } = require('../../config/env');
const inviteMail=require('../../config/inviteMail');
const outbox=require('../../platform/services/outbox.service');
function invalid(message,status=400){const e=new Error(message);e.status=status;return e;}
function checkStaff(input){
  const name=String(input.name||'').trim();const email=String(input.email||'').trim().toLowerCase();const role=String(input.role||'');
  if(name.length<2||name.length>120||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||!INVITABLE.includes(role)) throw invalid('Enter a valid name, email and supported staff role');
  return {name,email,role};
}
async function issueInvite(tenant,operator,input){
  if(!policy.canManage(operator))throw policy.denied();
  const inviteQueued=inviteMail.configured();
  const values=checkStaff(input);
  values.branchId=String(input.branchId||'');
  if(!/^[a-f0-9]{24}$/i.test(values.branchId))throw invalid('An active branch assignment is required');
  values.allowedModules=validateAssignments(tenant,values.role,input.allowedModules);
  policy.enforceAssignment(tenant,operator,values.role,values.branchId,values.allowedModules);
  const conn=getTenantConnection(tenant.slug);
  await ensureTenantIndexes(conn);
  const User=tenantUserModel(conn), Invite=staffInviteModel(conn), Audit=auditEventModel(conn), Branch=branchModel(conn);
  const limits=limitsFor(tenant);
  if(!limits)throw invalid('Subscription inactive or expired',403);
  const token=crypto.randomBytes(32).toString('hex');
  const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
  const session=await mongoose.startSession();
  try{
    await session.withTransaction(async()=>{
      const branch=await Branch.findOneAndUpdate({_id:values.branchId,status:'active'},{$inc:{revision:1}},{session,new:true});
      if(!branch)throw invalid('Selected branch is inactive or unavailable',409);
      // Release expired unused seats within same transaction before reserve.
      const expired=await Invite.find({status:'pending',expiresAt:{$lte:new Date()}}).session(session);
      if(expired.length){
        await Invite.updateMany({_id:{$in:expired.map(x=>x._id)},status:'pending'},{$set:{status:'expired'}},{session});
        await Tenant.updateOne({_id:tenant._id},{$inc:{seatsReserved:-expired.length}},{session});
      }
      if(await AccountIdentity.exists({email:values.email}).session(session) || await User.exists({email:values.email}).session(session)) throw invalid('This email is already registered',409);
      if(await Invite.exists({email:values.email,status:'pending'}).session(session))throw invalid('An active invitation already exists for this email',409);
      const reserved=await Tenant.findOneAndUpdate({_id:tenant._id, seatsReserved:{$lt:limits.users}},{$inc:{seatsReserved:1}}, {new:true,session});
      if(!reserved)throw invalid('The tenant has reached the plan user-seat limit',409);
      const expiresAt=new Date(Date.now()+24*60*60*1000);
      const [invite]=await Invite.create([{...values,tokenHash,createdBy:operator.id,expiresAt,status:'pending'}],{session});
      if(inviteQueued)await outbox.enqueue({key:`tenant.staff.invited:${invite._id}`,type:'tenant.staff.invited',tenantId:tenant._id,
        payload:{to:values.email,tenantName:tenant.name,recipientName:values.name,inviteId:invite._id,expiresAt,
          encryptedUrl:inviteMail.seal(`${appUrl}/accept-staff-invite?tenant=${encodeURIComponent(tenant.slug)}#token=${token}`)},session});
      await Audit.create([{action:'staff.invited',actorId:operator.id,targetId:invite._id,metadata:{role:values.role,branchId:values.branchId,allowedModules:values.allowedModules}}],{session});
    });
  }finally{await session.endSession();}
  return `${appUrl}/accept-staff-invite?tenant=${encodeURIComponent(tenant.slug)}#token=${token}`;
}
async function acceptStaffInvite(slug,token,password){
  if(!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(String(slug||''))||!/^[a-f0-9]{64}$/.test(String(token||''))||!validatePassword(password))throw invalid('Invalid invitation details or password (14+ mixed characters, up to 72 UTF-8 bytes)');
  const tenant=await Tenant.findOne({slug,status:{$in:['active','trial']}}).lean();
  if(!tenant)throw invalid('Tenant unavailable',403);
  const conn=getTenantConnection(slug);await ensureTenantIndexes(conn);
  const Invite=staffInviteModel(conn), User=tenantUserModel(conn), Audit=auditEventModel(conn), Branch=branchModel(conn);
  const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
  const session=await mongoose.startSession();
  try{
    await session.withTransaction(async()=>{
      const invite=await Invite.findOne({tokenHash,status:'pending',expiresAt:{$gt:new Date()}}).session(session);
      if(!invite)throw invalid('Invitation invalid or expired',400);
      const branch=await Branch.findOneAndUpdate({_id:invite.branchId,status:'active'},{$inc:{revision:1}},{session,new:true});
      if(!branch)throw invalid('Invitation branch is no longer active',409);
      if(await AccountIdentity.exists({email:invite.email}).session(session)) throw invalid('This email is already registered',409);
      const [user]=await User.create([{name:invite.name,email:invite.email,role:invite.role,permissions:permissionsFor(invite.role),branchId:invite.branchId,allowedModules:invite.allowedModules,passwordHash:await require('bcryptjs').hash(password,12),status:'active'}],{session});
      await AccountIdentity.create([{email:invite.email,kind:'tenant',accountId:user._id,tenantId:tenant._id}],{session});
      invite.status='accepted';invite.acceptedAt=new Date();await invite.save({session});
      await Audit.create([{action:'staff.activated',actorId:invite.createdBy,targetId:user._id,metadata:{role:invite.role,branchId:invite.branchId,allowedModules:invite.allowedModules}}],{session});
    });
  }catch(e){if(e.code===11000)throw invalid('This email is already registered',409);throw e;}finally{await session.endSession();}
  return tenant;
}
async function disableStaff(tenant,actor,userId){
  if(!policy.canManage(actor))throw policy.denied();
  if(!/^[a-f0-9]{24}$/i.test(String(userId)))throw invalid('Invalid staff user');
  if(String(actor.id)===String(userId))throw invalid('An owner cannot disable their own account',403);
  const conn=getTenantConnection(tenant.slug),User=tenantUserModel(conn),Audit=auditEventModel(conn);
  const session=await mongoose.startSession();
  try{
    await session.withTransaction(async()=>{
      const user=await User.findOneAndUpdate({_id:userId,...policy.staffFilter(actor),status:'active'},{$set:{status:'disabled'},$inc:{authVersion:1}},{new:true,session});
      if(!user)throw invalid('Staff member not found or already disabled',404);
      const seat=await Tenant.updateOne({_id:tenant._id,seatsReserved:{$gt:1}},{$inc:{seatsReserved:-1}},{session});
      if(seat.modifiedCount!==1)throw invalid('Seat counter conflict. Retry after checking subscription capacity',409);
      await Audit.create([{action:'staff.disabled',actorId:actor.id,targetId:user._id,metadata:{role:user.role,branchId:user.branchId}}],{session});
    });
  }finally{await session.endSession();}
}

async function updateStaff(tenant,actor,userId,input){
  if(!policy.canManage(actor))throw policy.denied();
  if(!/^[a-f0-9]{24}$/i.test(String(userId||'')) || String(userId)===String(actor.id))throw invalid('Cannot edit this account',403);
  const name=String(input.name||'').trim(), role=String(input.role||'');
  if(name.length<2||name.length>120||!INVITABLE.includes(role))throw invalid('Invalid name or role');
  const branchId=String(input.branchId||'');
  if(!/^[a-f0-9]{24}$/i.test(branchId))throw invalid('An active branch assignment is required');
  const allowedModules=validateAssignments(tenant,role,input.allowedModules);
  policy.enforceAssignment(tenant,actor,role,branchId,allowedModules);
  const conn=getTenantConnection(tenant.slug),User=tenantUserModel(conn),Branch=branchModel(conn),Audit=auditEventModel(conn);
  await ensureTenantIndexes(conn);
  const session=await mongoose.startSession();let edited;
  try{await session.withTransaction(async()=>{
    const branch=await Branch.findOneAndUpdate({_id:branchId,status:'active'},{$inc:{revision:1}},{new:true,session});
    if(!branch)throw invalid('Selected branch is inactive',409);
    edited=await User.findOneAndUpdate({_id:userId,...policy.staffFilter(actor),status:{$in:['active','disabled']}},{$set:{name,role,permissions:permissionsFor(role),branchId,allowedModules},$inc:{authVersion:1}},{new:true,session});
    if(!edited)throw invalid('Staff account not found',404);
    await Audit.create([{action:'staff.updated',actorId:actor.id,targetId:edited._id,metadata:{name,role,branchId,allowedModules}}],{session});
  });return edited;
  }finally{await session.endSession();}
}
async function cancelInvite(tenant,actor,inviteId){
  if(!policy.canManage(actor))throw policy.denied();
  if(!/^[a-f0-9]{24}$/i.test(String(inviteId||'')))throw invalid('Invalid invitation');
  const conn=getTenantConnection(tenant.slug),Invite=staffInviteModel(conn),Audit=auditEventModel(conn);
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    const invite=await Invite.findOneAndUpdate({_id:inviteId,...policy.directoryFilter(actor),status:'pending'},{$set:{status:'cancelled'}},{new:true,session});
    if(!invite)throw invalid('Pending invitation not found',404);
    // The platform mail worker never needs permission to read financial tenant DBs.
    // Cancel a still-pending delivery atomically with the invitation revocation.
    await require('../../platform/models/OutboxEvent').updateOne({eventKey:`tenant.staff.invited:${invite._id}`,state:'pending'},
      {$set:{state:'dead',failureCode:'invite_revoked',completedAt:new Date()}},{session});
    const seat=await Tenant.updateOne({_id:tenant._id,seatsReserved:{$gt:1}},{$inc:{seatsReserved:-1}},{session});
    if(seat.modifiedCount!==1)throw invalid('Seat counter conflict. Retry after checking subscription capacity',409);
    await Audit.create([{action:'staff.invitation_revoked',actorId:actor.id,targetId:invite._id,metadata:{role:invite.role,branchId:invite.branchId}}],{session});
  });}finally{await session.endSession();}
}

async function enableStaff(tenant,actor,userId){
  if(!policy.canManage(actor))throw policy.denied();
  if(!/^[a-f0-9]{24}$/i.test(String(userId||''))||String(actor.id)===String(userId))throw invalid('Invalid account',403);
  const limits=limitsFor(tenant);if(!limits)throw invalid('Subscription inactive or expired',403);
  const conn=getTenantConnection(tenant.slug),User=tenantUserModel(conn),Branch=branchModel(conn),Audit=auditEventModel(conn);
  await ensureTenantIndexes(conn);
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    const prior=await User.findOne({_id:userId,status:'disabled',...policy.staffFilter(actor)}).session(session);
    if(!prior)throw invalid('Disabled staff account not found',404);
    const branch=await Branch.findOneAndUpdate({_id:prior.branchId,status:'active'},{$inc:{revision:1}},{new:true,session});
    if(!branch)throw invalid('Assign an active branch before re-enabling this account',409);
    const seat=await Tenant.findOneAndUpdate({_id:tenant._id,seatsReserved:{$lt:limits.users}},{$inc:{seatsReserved:1}},{new:true,session});
    if(!seat)throw invalid('Seat limit reached. Change plan or free a seat first',409);
    const enabled=await User.findOneAndUpdate({_id:prior._id,status:'disabled',...policy.staffFilter(actor)},{$set:{status:'active'},$inc:{authVersion:1}},{new:true,session});
    if(!enabled)throw invalid('Account changed concurrently',409);
    await Audit.create([{action:'staff.enabled',actorId:actor.id,targetId:enabled._id,metadata:{role:enabled.role,branchId:enabled.branchId}}],{session});
  });}finally{await session.endSession();}
}
module.exports={checkStaff,issueInvite,acceptStaffInvite,disableStaff,updateStaff,cancelInvite,enableStaff};
