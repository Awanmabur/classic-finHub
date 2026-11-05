'use strict';
// All SMS authorization reads are fenced by writes in the same transaction as
// their receipt or financial record. Revocation and staff/subscription changes
// therefore either precede this operation or wait for its commit.
const SmsDevice=require('../../platform/models/SmsDevice');
const Tenant=require('../../platform/models/Tenant');
const {tenantUserModel,branchModel,smsInboxModel}=require('../models');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const {resolveTransactionBranch}=require('./transactionBranch.service');
const {fail,idempotencyKey}=require('./smsCrypto.service');
async function fenceOperator(conn,session,actor,tenant,branchId){
  const version=Number.isSafeInteger(actor.authVersion)?actor.authVersion:0;
  const account=await tenantUserModel(conn).findOneAndUpdate({_id:actor.id,status:'active',role:actor.role,
    authVersion:version===0?{$in:[0,null]}:version},{$inc:{__v:1}},{session,new:true}).lean();
  if(!account)throw fail('SMS operator authorization changed. Refresh and retry.',403);
  const {operatorFrom,entitlement}=require('./smsCapture.service');
  const current=operatorFrom(account);
  if(!['Tenant Owner','Mobile Money Operator'].includes(current.role))throw fail('SMS operator role is unavailable.',403);
  entitlement(tenant,current);
  const Branch={findOne:query=>branchModel(conn).findOne(query).session(session),find:query=>branchModel(conn).find(query).session(session)};
  const branch=await resolveTransactionBranch(conn,current,{}, {Branch});
  if(String(branch._id)!==String(branchId))throw fail('SMS operator branch changed. Re-enroll the device.',403);
  return current;
}
async function fenceDeviceContext(conn,session,{deviceId,tenantId,actor,branchId}){
  const device=await SmsDevice.findOneAndUpdate({deviceId,tenantId,operatorId:actor.id,branchId,status:'active'},
    {$inc:{revision:1}},{session,new:true}).lean();
  if(!device)throw fail('SMS device was revoked or its assignment changed.',403);
  const tenant=await Tenant.findOneAndUpdate({_id:tenantId,status:{$in:['active','trial']}},{$inc:{__v:1}},{session,new:true}).lean();
  if(!tenant||conn.name!==tenantDbNameFromSlug(tenant.slug))throw fail('SMS workspace is unavailable.',403);
  const current=await fenceOperator(conn,session,actor,tenant,branchId);
  return {device,tenant,actor:current};
}
async function authorizeRecording(conn,session,operator,tenant,context,branchId,values){
  const now=new Date();
  const inbox=await smsInboxModel(conn).findOneAndUpdate({_id:context.smsInboxId,operatorId:operator.id,branchId,
    state:'processing',processingUntil:{$gt:now},expiresAt:{$gt:now}},
    {$set:{processingUntil:new Date(now.getTime()+60000)}},{session,new:true}).lean();
  if(!inbox)throw fail('SMS recording lease or operator assignment is unavailable.',403);
  if(values.idempotencyKey!==idempotencyKey(inbox.deviceId,inbox.messageId))throw fail('SMS recording reference is invalid.',403);
  const expected=require('./mobileMoney.service').validate({...inbox.fields,idempotencyKey:values.idempotencyKey},inbox.fields?.operation);
  if(['operation','customer','network','networkReference','currency','amountMinor','feeMinor','idempotencyKey']
    .some(key=>String(expected[key])!==String(values[key])))throw fail('SMS draft changed before recording. Review it again.',409);
  const authorized=await fenceDeviceContext(conn,session,{deviceId:inbox.deviceId,tenantId:tenant._id,actor:operator,branchId});
  if(authorized.device.network!==values.network)throw fail('SMS network does not match the device.',403);
  return {...authorized,receivedAt:inbox.receivedAt};
}
module.exports={fenceDeviceContext,fenceOperator,authorizeRecording};
