'use strict';

const {Router}=require('express');
const {randomUUID}=require('node:crypto');
const {Types}=require('mongoose');
const requireModule=require('../../middleware/requireModule');
const requirePermission=require('../../middleware/requirePermission');
const {financial}=require('../../platform/services/actionThrottle.service');
const {flash}=require('../../utils/view');
const {mobileTransactionModel}=require('../models');
const {readScope}=require('../services/branchView.service');
const {hasModuleForUser,hasPermission}=require('../services/moduleAccess.service');
const mobile=require('../services/mobileMoney.service');
const correctionsUrl=id=>'/tenant/treasury?action=corrections'+
 (/^[a-f0-9]{24}$/i.test(String(id))?'&txRef='+encodeURIComponent(id):'')+'#reconcile';

async function list(req){
 if(req.user.role!=='Tenant Owner'||!hasModuleForUser(req.tenant,req.user,'mobile_money')||
    !hasPermission(req.user,'mobile_money.review'))return null;
 const reference=typeof req.query.txRef==='string'?req.query.txRef.trim().slice(0,100):'';
 const selected=reference?
  {$or:[{networkReference:reference},...(/^[a-f0-9]{24}$/i.test(reference)?[{_id:new Types.ObjectId(reference)}]:[])]}:
  {status:{$in:['recorded','pending_verification']},$or:[{correctionState:'requested'},{reviewState:'disputed',correctionState:{$ne:'voided'}}]};
 const records=await mobileTransactionModel(req.tenantDb).find({...readScope(req.user),...selected})
  .select('networkReference network operation currency amountMinor createdAt status reviewState correctionState correctionReason correctionRequestedAt fundingState customerAccountId')
  .sort(reference?{createdAt:-1,_id:-1}:{correctionRequestedAt:1,createdAt:1,_id:1}).limit(25).lean();
 return {reference,rows:records.map(row=>({
  ...row,canResolve:mobile.ownerCorrectionAvailable(row),request:mobile.correctionState(row),
  amount:mobile.formatMoneyMinor(row.amountMinor,row.currency),idempotencyKey:randomUUID()
 }))};
}

function router(){
 const result=Router();
 result.post('/mobile-corrections/:id',requireModule('mobile_money'),requirePermission('mobile_money.review'),financial,async(req,res,next)=>{
  try{
   const {record,duplicate}=await mobile.resolveOwnerCorrection(
    req.tenantDb,req.tenant,req.user,req.params.id,req.body,req.viewBranch?._id
   );
   flash(req,'good',duplicate?'This correction decision was already recorded.':
    record.correctionState==='voided'?'Internal transaction reversed and audited.':'Correction declined. The existing transaction remains recorded.');
   res.redirect(303,correctionsUrl(record._id));
  }catch(error){
   if(req.user.role!=='Tenant Owner'||![400,409].includes(error.status))return next(error);
   flash(req,'bad',error.message);
   res.redirect(303,correctionsUrl(req.params.id));
  }
 });
 return result;
}

module.exports={list,router};
