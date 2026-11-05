'use strict';
// Manually counted physical cash, never network e-float or provider settlement.
const {Types}=require('mongoose');
const {cashSessionModel,mobileTransactionModel,auditEventModel,branchModel,ensureTenantIndexes}=require('../models');
const {hasModuleForUser}=require('./moduleAccess.service');
const mobile=require('./mobileMoney.service');
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
function id(v){if(!/^[a-f0-9]{24}$/i.test(String(v||'')))throw fail('Invalid identifier');return new Types.ObjectId(v);}
function decimal(v){return Types.Decimal128.fromString(String(v));}
function minor(v){return BigInt(String(v));}
function note(v,required=true){if(typeof v!=='string'||v.trim().length>(400)||(required&&v.trim().length<12))throw fail('A 12–400 character explanation is required');return v.trim();}
function key(branchId,operatorId){return `${id(branchId)}:${id(operatorId)}`;}
function scope(actor){return ['Tenant Owner','Auditor'].includes(actor?.role)?{}:{branchId:id(actor?.branchId)};}
function visibleScope(actor){return {...scope(actor),...(actor.role==='Mobile Money Operator'?{operatorId:id(actor.id)}:{})};}
function allowed(tenant,actor){if(!hasModuleForUser(tenant,actor,'mobile_money'))throw fail('Mobile Money module assignment required',403);
 if(!['Tenant Owner','Mobile Money Operator','Branch Manager','Reconciliation Officer','Auditor'].includes(actor?.role))
   throw fail('Physical cash count information is restricted to authorized operations staff',403);}
function opener(actor){return ['Tenant Owner','Mobile Money Operator'].includes(actor?.role);}
function reviewer(actor){return ['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(actor?.role);}
async function open(conn,tenant,actor,input={}){
 allowed(tenant,actor);if(!opener(actor))throw fail('Not permitted to open cash shifts',403);
 const branchId=id(actor.role==='Tenant Owner'?input.branchId:actor.branchId),operatorId=id(actor.id);
 await ensureTenantIndexes(conn);
 const branch=await branchModel(conn).findOne({_id:branchId,status:'active'}).lean();
 if(!branch)throw fail('Active branch required',409);
 const opening=mobile.toMinor(input.openingCash,branch.currency,true);
 const tx=await conn.startSession();let created;
 try{await tx.withTransaction(async()=>{
   const touched=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'active'},{$inc:{revision:1}},{new:true,session:tx});
   if(!touched)throw fail('Branch unavailable',409);
   [created]=await cashSessionModel(conn).create([{branchId,operatorId,currency:branch.currency,activeKey:key(branchId,operatorId),openingMinor:decimal(opening),provisionalMovementMinor:decimal(0),status:'pending_open'}],{session:tx});
   await auditEventModel(conn).create([{action:'mobile_money.shift.opened',actorId:operatorId,targetId:created._id,metadata:{branchId:String(branchId),currency:branch.currency}}],{session:tx});
 });return created;
 }catch(e){if(e.code===11000)throw fail('An unfinished shift already exists for this operator and branch',409);throw e;}
 finally{await tx.endSession();}
}
// Dual control of the opening cash count. Rejected requests cannot be reused.
async function decideOpening(conn,tenant,actor,shiftId,input={}){
 allowed(tenant,actor);if(!reviewer(actor))throw fail('Independent branch supervisor required for opening verification',403);
 if(!['approve','reject'].includes(input.decision))throw fail('Invalid opening decision');
 const reason=note(input.note);await ensureTenantIndexes(conn);
 const tx=await conn.startSession();let result;
 try{await tx.withTransaction(async()=>{
  result=await cashSessionModel(conn).findOneAndUpdate({_id:id(shiftId),status:'pending_open',operatorId:{$ne:id(actor.id)},...scope(actor)},
   {$set:{status:input.decision==='approve'?'open':'opening_rejected',openingVerifiedBy:id(actor.id),openingVerifiedAt:new Date(),openingReviewNote:reason},
    ...(input.decision==='reject'?{$unset:{activeKey:''}}:{}),$inc:{revision:1}},{session:tx,new:true});
  if(!result)throw fail('Opening request unavailable, already reviewed, outside your branch or self-approval attempted',409);
  await auditEventModel(conn).create([{action:`mobile_money.shift.opening_${input.decision==='approve'?'approved':'rejected'}`,
    actorId:id(actor.id),targetId:result._id,metadata:{branchId:String(result.branchId),currency:result.currency}}],{session:tx});
 });return result;
 }finally{await tx.endSession();}
}
// Atomic with the original network record, not with external provider settlement.
async function attachRecord(conn,tx,operator,branchId,currency,operation,amountMinor){
 const shift=await cashSessionModel(conn).findOneAndUpdate({activeKey:key(branchId,operator.id),status:'open',currency},
  {$inc:{revision:1,recordCount:1,provisionalMovementMinor:decimal(operation==='cash_in'?amountMinor:-amountMinor)}},{new:true,session:tx});
 if(!shift)throw fail('Open a cash shift before recording operations',409);
 if(minor(shift.openingMinor)+minor(shift.provisionalMovementMinor)<0n)throw fail('Insufficient provisional cash for this cash-out',409);
 return shift._id;
}
// Prevent close/approval racing with reviews and corrections.
async function fenceRecordChange(conn,tx,record,offset=0n){
 if(!record.cashSessionId)return; // Prior-version records stay historical/unassigned.
 const shift=await cashSessionModel(conn).findOneAndUpdate({_id:record.cashSessionId,status:{$in:['open','disputed']}},
  {$inc:{revision:1,provisionalMovementMinor:decimal(offset)}},{new:true,session:tx});
 if(!shift)throw fail('Shift submitted or approved; first dispute the shift before editing its records',409);
 if(minor(shift.openingMinor)+minor(shift.provisionalMovementMinor)<0n)throw fail('Correction would make provisional cash negative',409);
}
async function submit(conn,tenant,actor,shiftId,input={}){
 allowed(tenant,actor);if(!opener(actor))throw fail('Only the originating operator may submit counts',403);
 await ensureTenantIndexes(conn);
 const tx=await conn.startSession();let result;
 try{await tx.withTransaction(async()=>{
   result=await cashSessionModel(conn).findOneAndUpdate({_id:id(shiftId),operatorId:id(actor.id),status:{$in:['open','disputed']},...visibleScope(actor)},
    {$set:{status:'submitted'},$inc:{revision:1}},{new:true,session:tx});
   if(!result)throw fail('No editable shift belonging to this operator',409);
   const Money=mobileTransactionModel(conn);
   const outstanding=await Money.countDocuments({cashSessionId:result._id,$nor:[
     {status:'voided_internal',correctionState:'voided'},
     {status:'pending_verification',reviewState:'accepted',correctionState:{$nin:['requested','voided']}}
   ]}).session(tx);
   if(outstanding)throw fail(`Review or void ${outstanding} unresolved records before closing`,409);
   const counted=await Money.countDocuments({cashSessionId:result._id}).session(tx);
   if(counted!==result.recordCount)throw fail('Cash shift record count mismatch',409);
   // Recompute movement from immutable source records. Comparing with the
   // incrementally maintained drawer figure catches drift or missing updates.
   const aggregation=await Money.aggregate([{$match:{cashSessionId:result._id}},
    {$group:{_id:null,movement:{$sum:{$cond:[{$eq:['$status','voided_internal']},
      0,{$cond:[{$eq:['$operation','cash_in']},'$amountMinor',{$multiply:['$amountMinor',-1]}]}]}}}}]).session(tx);
   const computed=BigInt(String(aggregation[0]?.movement||'0'));
   if(computed!==minor(result.provisionalMovementMinor))throw fail('Cash shift movement does not reconcile with original records',409);
   const declared=BigInt(mobile.toMinor(input.countedCash,result.currency,true));
   const expected=minor(result.openingMinor)+minor(result.provisionalMovementMinor);
   if(expected<0n)throw fail('Invalid estimated cash balance',409);
   const variance=declared-expected, reason=note(input.note||'',variance!==0n);
   result=await cashSessionModel(conn).findOneAndUpdate({_id:result._id,status:'submitted'},{$set:{
    declaredClosingMinor:decimal(declared),expectedClosingMinor:decimal(expected),varianceMinor:decimal(variance),submittedAt:new Date(),
    reviewedBy:null,reviewedAt:null,reviewNote:null},$push:{closeHistory:{at:new Date(),actorId:id(actor.id),
    declaredMinor:decimal(declared),expectedMinor:decimal(expected),varianceMinor:decimal(variance),note:reason||'Cash counted'}}},
    {new:true,session:tx});
   await auditEventModel(conn).create([{action:'mobile_money.shift.submitted',actorId:id(actor.id),targetId:result._id,
    metadata:{branchId:String(result.branchId),currency:result.currency,varianceMinor:String(variance)}}],{session:tx});
 });return result;
 }finally{await tx.endSession();}
}
async function decide(conn,tenant,actor,shiftId,input={}){
 allowed(tenant,actor);if(!reviewer(actor))throw fail('Independent cash supervisors only',403);
 if(!['approve','dispute'].includes(input.decision))throw fail('Invalid decision');const reason=note(input.note);
 await ensureTenantIndexes(conn);
 const tx=await conn.startSession();let result;
 try{await tx.withTransaction(async()=>{
  result=await cashSessionModel(conn).findOneAndUpdate({_id:id(shiftId),status:'submitted',operatorId:{$ne:id(actor.id)},...scope(actor)},
   {$set:{status:input.decision==='approve'?'approved':'disputed',reviewedBy:id(actor.id),reviewedAt:new Date(),reviewNote:reason},
    ...(input.decision==='approve'?{$unset:{activeKey:''}}:{}),$inc:{revision:1}},
   {new:true,session:tx});
  if(!result)throw fail('Shift unavailable, outside your branch or owned by the reviewer',409);
  // A Branch Manager may reconcile exact matches, but only a Tenant Owner or
  // Reconciliation Officer may accept a discrepancy. The transaction will
  // roll back when this authorization fails.
  if(input.decision==='approve'&&minor(result.varianceMinor)!==0n&&actor.role==='Branch Manager')
   throw fail('Cash variance approvals require a Tenant Owner or Reconciliation Officer',403);
  await auditEventModel(conn).create([{action:`mobile_money.shift.${input.decision==='approve'?'approved':'disputed'}`,
   actorId:id(actor.id),targetId:result._id,metadata:{branchId:String(result.branchId),currency:result.currency,varianceMinor:String(result.varianceMinor)}}],{session:tx});
 });return result;
 }finally{await tx.endSession();}
}
async function list(conn,tenant,actor,{cursor}={}){
 allowed(tenant,actor);
 const position=mobile.decodeCursor(cursor),query=visibleScope(actor);
 if(position)query.$or=[{createdAt:{$lt:position.at}},{createdAt:position.at,_id:{$lt:id(position.id)}}];
 const all=await cashSessionModel(conn).find(query).sort({createdAt:-1,_id:-1}).limit(41).lean();
 const items=all.slice(0,40);
 return {items,nextCursor:all.length>40?mobile.encodeCursor(items.at(-1)):null};
}
async function detail(conn,tenant,actor,shiftId){
 allowed(tenant,actor);
 const found=await cashSessionModel(conn).findOne({_id:id(shiftId),...visibleScope(actor)}).lean();
 if(!found)throw fail('Cash shift not found within your permissions',404);return found;
}
async function reportRows({conn,filters,scope:filter}){
 const match={createdAt:mobile.dateBounds({from:filters.from,to:filters.to}),
  // Aggregation pipelines do not apply Mongoose schema casting. CashSession
  // stores branchId as ObjectId, so a string would silently produce zero rows.
  ...require('../reporting/aggregateScope').branchMatch(filter, value=>new Types.ObjectId(value))};
 const rows=await cashSessionModel(conn).aggregate([{$match:match},
 {$group:{_id:{currency:'$currency',status:'$status'},count:{$sum:1},expected:{$sum:{$ifNull:['$expectedClosingMinor',0]}}}},
 {$sort:{'_id.currency':1,'_id.status':1}}]);
 return rows.map(r=>({module:'Mobile Money',activity:'Physical cash shifts',status:r._id.status,currency:r._id.currency,
 count:r.count,volume:mobile.formatMoneyMinor(r.expected||0,r._id.currency),fees:'N/A'}));
}
module.exports={open,decideOpening,attachRecord,fenceRecordChange,submit,decide,list,detail,reportRows,key,minor,decimal,visibleScope,opener,reviewer};
