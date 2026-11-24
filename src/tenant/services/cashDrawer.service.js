'use strict';
// Manually counted physical cash, never network e-float or provider settlement.
const {Types}=require('mongoose');
const {randomUUID}=require('node:crypto');
const {cashSessionModel,mobileTransactionModel,auditEventModel,branchModel,ensureTenantIndexes}=require('../models');
const {hasModuleForUser}=require('./moduleAccess.service');
const mobile=require('./mobileMoney.service');
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
function id(v){if(!/^[a-f0-9]{24}$/i.test(String(v||'')))throw fail('Invalid identifier');return new Types.ObjectId(v);}
function decimal(v){return Types.Decimal128.fromString(String(v));}
function minor(v){return BigInt(String(v));}
function note(v,required=true){if(typeof v!=='string'||v.trim().length>(400)||(required&&v.trim().length<12))throw fail('A 12–400 character explanation is required');return v.trim();}
function key(branchId,operatorId,currency){const legacy=`${id(branchId)}:${id(operatorId)}`;if(currency===undefined)return legacy;if(!Object.hasOwn(mobile.currencies,currency))throw fail('Choose a supported cash currency');return `${legacy}:${currency}`;}
function activeFilter(branchId,operatorId,currency){return {branchId:id(branchId),operatorId:id(operatorId),currency,activeKey:{$in:[key(branchId,operatorId,currency),key(branchId,operatorId)]}};}
function scope(actor){return ['Tenant Owner','Auditor'].includes(actor?.role)?require('./branchView.service').readScope(actor):{branchId:id(actor?.branchId)};}
function visibleScope(actor){return {...scope(actor),...(['Mobile Money Operator','Money Transfer Operator','Banking Operator','Forex Operator'].includes(actor.role)?{operatorId:id(actor.id)}:{})};}
function allowed(tenant,actor){
 if(!['mobile_money','money_transfer','banking','forex','expenses'].some(key=>hasModuleForUser(tenant,actor,key)))throw fail('An assigned operational module is required for cash controls',403);
 if(!['Tenant Owner','Mobile Money Operator','Money Transfer Operator','Banking Operator','Forex Operator','Branch Manager','Reconciliation Officer','Auditor'].includes(actor?.role))throw fail('Cash controls require authorized operations staff',403);
}
function opener(actor){return ['Tenant Owner','Branch Manager','Mobile Money Operator','Money Transfer Operator','Banking Operator','Forex Operator'].includes(actor?.role);}
function reviewer(actor){return ['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(actor?.role);}
function verifyBookCount(input,expected){
 if(input.countedBookMinor!==undefined&&String(input.countedBookMinor)!==String(expected))
  throw fail('The book balance changed. Count the cash again using the updated balance.',409);
}
function countAmount(value,currency){
 const scale=mobile.currencies[currency],factor=10n**BigInt(scale),amount=BigInt(value);
 return String(amount/factor)+(scale?'.'+String(amount%factor).padStart(scale,'0'):'');
}
async function confirmOwnerCount(conn,session,authorization,observationId,reason){
 const funds=require('../treasury/service');
 const observation=await funds.reviewObservationInSession(conn,session,authorization,observationId,{
  decision:'approve',note:reason
 },{ownerDirectCheck:true});
 if(minor(observation.varianceMinorAtReview)!==0n)
  await funds.reconcileOwnerObservationInSession(conn,session,authorization,observationId,{reason,idempotencyKey:randomUUID()});
 return observation;
}
async function open(conn,tenant,actor,input={},options={}){
 allowed(tenant,actor);if(!opener(actor))throw fail('Not permitted to open cash shifts',403);
 const ownerDirect=options.ownerDirect===true&&actor.role==='Tenant Owner';
 const branchId=String((await require('./transactionBranch.service').resolveTransactionBranch(conn,actor,input))._id),operatorId=id(actor.id);
 await ensureTenantIndexes(conn);
 const branch=await branchModel(conn).findOne({_id:branchId,status:'active'}).lean();
 if(!branch)throw fail('Active branch required',409);
 const currency=require('./branchCurrency.service').resolve(branch,input.currency);
 const useBookCount=input.openingFromBook==='on';
 if(useBookCount&&input.physicalCountConfirmed!=='on')throw fail('Count physical cash and confirm it matches the current book before starting a shift',400);
 const manuallyCounted=useBookCount?null:ownerDirect?
  require('../treasury/service').major(input.openingCash,currency):mobile.toMinor(input.openingCash,currency,true);
 const tx=await conn.startSession();let created;
 try{await tx.withTransaction(async()=>{
   const touched=await branchModel(conn).findOneAndUpdate({_id:branchId,status:'active'},{$inc:{revision:1}},{new:true,session:tx});
   if(!touched)throw fail('Branch unavailable',409);
   require('./branchCurrency.service').resolve(touched,currency);
   if(await cashSessionModel(conn).exists({...activeFilter(branchId,operatorId,currency),status:{$in:['pending_open','open','submitted','disputed']}}).session(tx))throw fail('An unfinished cash shift already exists for this operator, branch and currency',409);
   const funds=require('../treasury/service'),fund=await funds.findAccount(conn,tx,{branchId,kind:'cash',currency,operatorId:actor.id});
   const verifiedFund=fund&&fund.openingBalanceMinor!==null&&fund.openingApprovedAt;
   if(ownerDirect&&!verifiedFund)throw fail('Add the starting balance to your cash account before opening the day.',409);
   if(useBookCount&&(!fund||fund.openingBalanceMinor===null||!fund.openingApprovedAt||fund.status!=='active'||fund.reconciliationState!=='matched'))
    throw fail('An active, reconciled cash drawer is required to reuse the automatic book balance',409);
   const opening=useBookCount?String(fund.bookBalanceMinor):manuallyCounted;
   if(useBookCount)verifyBookCount(input,opening);
   let observationId=null,openingNote=null;
   const shiftId=new Types.ObjectId();
   if(fund&&fund.openingBalanceMinor!==null){
    if(!ownerDirect&&(fund.status!=='active'||fund.reconciliationState!=='matched'))throw fail('Reconcile the actual cash account before opening another day',409);
    await funds.assertBookIntegrity(conn,tx,fund);
    const differs=minor(fund.bookBalanceMinor)!==BigInt(opening);
    if(differs&&!ownerDirect)throw fail('The counted opening cash differs from the funds book. Record and reconcile the difference before opening.',409);
    if(ownerDirect){
     if(fund.status==='archived')throw fail('Restore the cash account before opening the day.',409);
     const authorization=await funds.access(conn,tenant,actor,{permission:'treasury.review',session:tx,fence:true});
     const operatingBranch=await require('./transactionBranch.service').resolveTransactionBranch(conn,authorization.actor,{branchId});
     if(String(operatingBranch._id)!==branchId)throw fail('Your operating branch changed. Reload the cash day.',409);
     openingNote=differs?note(input.note||''):'Owner counted and confirmed opening cash.';
     const observed=await funds.requestObservationInSession(conn,tx,authorization,fund._id,{
      kind:'checkpoint',actualBalance:countAmount(opening,currency),observedAt:new Date().toISOString(),
      evidenceType:'cash_count',evidenceReference:`OPEN-SHIFT:${shiftId}`,note:openingNote,idempotencyKey:randomUUID()
     });
     await confirmOwnerCount(conn,tx,authorization,observed.observation._id,openingNote);
     observationId=observed.observation._id;
    }
   }
   [created]=await cashSessionModel(conn).create([{_id:shiftId,branchId,operatorId,currency,activeKey:key(branchId,operatorId,currency),openingMinor:decimal(opening),provisionalMovementMinor:decimal(0),status:ownerDirect?'open':'pending_open',
    ...(ownerDirect?{treasuryOpeningObservationId:observationId,openingVerifiedBy:operatorId,openingVerifiedAt:new Date(),openingReviewNote:openingNote}:{}),
    ...(fund&&fund.openingBalanceMinor!==null?{treasuryAccountId:fund._id,treasuryBoundAt:new Date(),treasuryBaselineMinor:decimal(opening)}:{})}],{session:tx});
   if(created.treasuryAccountId&&!ownerDirect){
    const authorization=await funds.access(conn,tenant,actor,{permission:'treasury.observe',session:tx,fence:true});
    const observed=await funds.requestObservationInSession(conn,tx,authorization,fund._id,{kind:'checkpoint',actualBalance:countAmount(opening,currency),observedAt:new Date().toISOString(),evidenceType:'cash_count',evidenceReference:`OPEN-SHIFT:${created._id}`,note:'Physical cash counted at the start of the operating day; independent verification required.',idempotencyKey:randomUUID()});
    created=await cashSessionModel(conn).findByIdAndUpdate(created._id,{$set:{treasuryOpeningObservationId:observed.observation._id}},{new:true,session:tx});
   }
   await auditEventModel(conn).create([{action:'mobile_money.shift.opened',actorId:operatorId,targetId:created._id,metadata:{branchId:String(branchId),currency,ownerConfirmed:ownerDirect}}],{session:tx});
 });return created;
 }catch(e){if(e.code===11000)throw fail('An unfinished shift already exists for this operator, branch and currency',409);throw e;}
 finally{await tx.endSession();}
}
// Dual control of the opening cash count. Rejected requests cannot be reused.
async function decideOpening(conn,tenant,actor,shiftId,input={},options={}){
 allowed(tenant,actor);if(!reviewer(actor))throw fail('Independent branch supervisor required for opening verification',403);
 if(!['approve','reject'].includes(input.decision))throw fail('Invalid opening decision');
 const ownerDirect=options.ownerDirect===true&&actor.role==='Tenant Owner';
 const reason=note(input.note||(ownerDirect&&input.decision==='approve'?'Owner confirmed the submitted opening cash count.':''));
 await ensureTenantIndexes(conn);
 const tx=await conn.startSession();let result;
 try{await tx.withTransaction(async()=>{
  result=await cashSessionModel(conn).findOneAndUpdate({_id:id(shiftId),status:'pending_open',...(require('./reviewPolicy').canSelfReviewRoutine(actor,actor.branchId)?{}:{operatorId:{$ne:id(actor.id)}}),...scope(actor)},
   {$set:{status:input.decision==='approve'?'open':'opening_rejected',openingVerifiedBy:id(actor.id),openingVerifiedAt:new Date(),openingReviewNote:reason},
    ...(input.decision==='reject'?{$unset:{activeKey:''}}:{}),$inc:{revision:1}},{session:tx,new:true});
  if(!result)throw fail('Opening request unavailable, already reviewed, outside your branch or already reviewed',409);
  if(String(result.operatorId)===String(actor.id)&&
    !await require('./reviewPolicy').persistedRoutineReviewer(conn,tx,actor,result.branchId))
   throw fail('Self-review requires the current authorized owner or assigned manager role',403);
  const funds=require('../treasury/service');
  const authorization=ownerDirect||result.treasuryOpeningObservationId?
   await funds.access(conn,tenant,actor,{permission:'treasury.review',session:tx,fence:true}):null;
  if(result.treasuryOpeningObservationId){
   await funds.reviewObservationInSession(conn,tx,authorization,result.treasuryOpeningObservationId,{decision:input.decision,note:reason});
  }
  await auditEventModel(conn).create([{action:`mobile_money.shift.opening_${input.decision==='approve'?'approved':'rejected'}`,
    actorId:id(actor.id),targetId:result._id,metadata:{branchId:String(result.branchId),currency:result.currency,selfReviewed:String(result.operatorId)===String(actor.id)}}],{session:tx});
 });return result;
 }finally{await tx.endSession();}
}
// A fund is counted once: binding an old drawer is permitted only when its
// existing expected cash equals the verified treasury book before the movement.
async function bindFundAccount(conn,session,account,balanceBeforeMinor,options={}){
 if(account?.kind!=='cash'||!account.operatorId)throw fail('Cash funds must belong to an assigned operator',409);
 const shift=await cashSessionModel(conn).findOneAndUpdate({branchId:account.branchId,operatorId:account.operatorId,currency:account.currency,
  status:{$in:['open','disputed']},openingVerifiedAt:{$ne:null},$or:[{treasuryAccountId:null},{treasuryAccountId:account._id}]},
  {$inc:{revision:1}},{new:true,session}).lean();
 if(!shift){
  const unfinished=options.allowNoActiveShift?await cashSessionModel(conn).exists({branchId:account.branchId,operatorId:account.operatorId,currency:account.currency,status:{$in:['pending_open','open','submitted','disputed']}}).session(session):true;
  if(options.allowNoActiveShift&&!unfinished)return null;
  throw fail('Open and independently verify the assigned operator cash drawer before posting cash movements',409);
 }
 if(minor(shift.openingMinor)+minor(shift.provisionalMovementMinor)!==BigInt(String(balanceBeforeMinor))){
  const error=fail('Cash shift and cash-book balances are out of sync. No funds were posted. Check the assigned cash drawer, shift opening and any intervening movements; reconcile the difference before retrying.',409);
  error.code='CASH_SHIFT_BOOK_MISMATCH';throw error;
 }
 if(!shift.treasuryAccountId)await cashSessionModel(conn).updateOne({_id:shift._id,treasuryAccountId:null},{$set:{treasuryAccountId:account._id,treasuryBoundAt:new Date(),treasuryBaselineMinor:decimal(balanceBeforeMinor)}},{session});
 return shift;
}
async function refreshFundBalance(conn,session,account,balanceAfterMinor,options={}){
 const shift=await cashSessionModel(conn).findOne({treasuryAccountId:account._id,operatorId:account.operatorId,currency:account.currency,status:{$in:['open','disputed']}}).session(session).lean();
 if(!shift){
  const unfinished=options.allowNoActiveShift?await cashSessionModel(conn).exists({branchId:account.branchId,operatorId:account.operatorId,currency:account.currency,status:{$in:['pending_open','open','submitted','disputed']}}).session(session):true;
  if(options.allowNoActiveShift&&!unfinished)return null;
  throw fail('The linked physical drawer is no longer open',409);
 }
 const movement=BigInt(String(balanceAfterMinor))-minor(shift.openingMinor);
 const updated=await cashSessionModel(conn).findOneAndUpdate({_id:shift._id,status:{$in:['open','disputed']}},{$set:{provisionalMovementMinor:decimal(movement)},$inc:{revision:1}},{new:true,session});
 if(!updated)throw fail('Cash closing changed concurrently. Retry after reconciliation.',409);
 return updated;
}
// SMS can arrive late. Check the verified shift boundary before booking any
// cash/float movement (Treasury also rejects movements older than its opening).
// The later attachRecord still takes the shift revision fence inside the same
// transaction so a concurrent close cannot race a successful posting.
function assertSmsShiftTime(shift,receivedAt){
 if(!receivedAt)return;
 const occurred=new Date(receivedAt);
 if(!Number.isFinite(occurred.valueOf())||!shift?.openingVerifiedAt||
  occurred<new Date(shift.createdAt)||occurred<new Date(shift.openingVerifiedAt)){
  const error=fail('This SMS predates the current verified cash shift. Keep it for historical reconciliation instead of recording it in this drawer.',409);
  error.code='SMS_SHIFT_MISMATCH';throw error;
 }
}
async function assertSmsWithinShift(conn,tx,actor,branchId,currency,receivedAt){
 if(!receivedAt)return;
 const shift=await cashSessionModel(conn).findOne({...activeFilter(branchId,actor.id,currency),status:'open'}).session(tx).lean();
 if(!shift)throw fail('Open and independently verify your physical cash shift before recording an SMS transaction',409);
 assertSmsShiftTime(shift,receivedAt);
}
// Atomic with the original network record, not with external provider settlement.
async function attachRecord(conn,tx,operator,branchId,currency,operation,amountMinor,smsContext=null){
 const shift=await cashSessionModel(conn).findOneAndUpdate({...activeFilter(branchId,operator.id,currency),status:'open'},
  {$inc:{revision:1,recordCount:1,...(smsContext?.bookManaged?{}:{provisionalMovementMinor:decimal(operation==='cash_in'?amountMinor:-amountMinor)})}},{new:true,session:tx});
 if(!shift)throw fail('Open a cash shift before recording operations',409);
 assertSmsShiftTime(shift,smsContext?.receivedAt);
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
async function submit(conn,tenant,actor,shiftId,input={},options={}){
 allowed(tenant,actor);if(!opener(actor))throw fail('Only the originating operator may submit counts',403);
 const ownerDirect=options.ownerDirect===true&&actor.role==='Tenant Owner';
 await ensureTenantIndexes(conn);
 const tx=await conn.startSession();let result;
 try{await tx.withTransaction(async()=>{
   result=await cashSessionModel(conn).findOneAndUpdate({_id:id(shiftId),operatorId:id(actor.id),status:{$in:['open','disputed']},...visibleScope(actor)},
    { ...(ownerDirect?{}:{$set:{status:'submitted'}}),$inc:{revision:1}},{new:true,session:tx});
   if(!result)throw fail('No editable shift belonging to this operator',409);
   const funds=require('../treasury/service');
   const ownerAuthorization=ownerDirect?await funds.access(conn,tenant,actor,{permission:'treasury.review',session:tx,fence:true}):null;
   const Money=mobileTransactionModel(conn);
   const outstanding=await Money.countDocuments({cashSessionId:result._id,$nor:[
     {status:'voided_internal',correctionState:'voided'},
     {status:{$in:['recorded','pending_verification']},correctionState:{$nin:['requested','voided']}}
   ]}).session(tx);
   if(outstanding)throw fail(`Resolve ${outstanding} outstanding record corrections before closing`,409);
   const counted=await Money.countDocuments({cashSessionId:result._id}).session(tx);
   if(counted!==result.recordCount)throw fail('Cash shift record count mismatch',409);
   const Expenses=require('../models/expenses').expenseModel(conn);
   const unresolvedExpenses=await Expenses.countDocuments({cashSessionId:result._id,
    $or:[{status:'pending_review'},{correctionState:'requested'}]}).session(tx);
   if(unresolvedExpenses)throw fail(`Resolve ${unresolvedExpenses} pending expense entries before closing`,409);
   if(result.treasuryAccountId){
    const unresolved=await require('../funded/models').models(conn).execution.countDocuments({branchId:result.branchId,createdBy:result.operatorId,status:'pending_review',$or:['cashAccountId','settlementAccountId','collectionAccountId','payoutAccountId'].map(key=>({['accounts.'+key]:result.treasuryAccountId}))}).session(tx);
    if(unresolved)throw fail(`Resolve ${unresolved} pending money entries before closing`,409);
    const pendingFunding=await require('../treasury/funding.models').model(conn).exists({
     tenantId:tenant._id,branchId:result.branchId,status:'pending_review',
     $or:[{sourceAccountId:result.treasuryAccountId},{destinationAccountId:result.treasuryAccountId}]
    }).session(tx);
    if(pendingFunding)throw fail('Resolve pending money added or transferred to this drawer before closing',409);
   }
   // Recompute movement from immutable source records. Comparing with the
   // incrementally maintained drawer figure catches drift or missing updates.
   const aggregation=await Money.aggregate([{$match:{cashSessionId:result._id}},
    {$group:{_id:null,movement:{$sum:{$cond:[{$or:[{$eq:['$status','voided_internal']},{$ne:[{$ifNull:['$paymentMethod','Cash']},'Cash']}]},
      0,{$ifNull:['$physicalCashMovementMinor',{$cond:[{$eq:['$operation','cash_in']},'$amountMinor',{$multiply:['$amountMinor',-1]}]}]}]}}}}]).session(tx);
   const expenseAggregation=await Expenses.aggregate([{$match:{cashSessionId:result._id,paymentMethod:'Cash',status:'approved'}},
    {$group:{_id:null,amount:{$sum:'$amountMinor'}}}]).session(tx);
   const computed=BigInt(String(aggregation[0]?.movement||'0'))-BigInt(String(expenseAggregation[0]?.amount||'0'));
   if(result.treasuryAccountId){
    const fund=await require('../treasury/models').models(conn).account.findOne({_id:result.treasuryAccountId,branchId:result.branchId,operatorId:result.operatorId,currency:result.currency}).session(tx).lean();
    if(!fund||minor(fund.bookBalanceMinor)!==minor(result.openingMinor)+minor(result.provisionalMovementMinor))throw fail('Cash drawer and treasury book do not reconcile',409);
   }else if(computed!==minor(result.provisionalMovementMinor))throw fail('Cash shift movement does not reconcile with original records',409);
   const expected=minor(result.openingMinor)+minor(result.provisionalMovementMinor);
   const useBookCount=input.closingFromBook==='on';
   if(useBookCount&&input.physicalCountConfirmed!=='on')
    throw fail('Count physical closing cash and confirm it matches the book amount before submitting',400);
   if(useBookCount)verifyBookCount(input,expected);
   const declared=useBookCount?expected:ownerDirect?
    funds.major(input.countedCash,result.currency):BigInt(mobile.toMinor(input.countedCash,result.currency,true));
   if(expected<0n)throw fail('Invalid estimated cash balance',409);
   const variance=declared-expected, reason=note(input.note||'',variance!==0n);
   if(ownerDirect&&variance!==0n&&!result.treasuryAccountId)
    throw fail('Link the shift to its cash account before recording a cash difference.',409);
   let treasuryObservationId=null;
   if(result.treasuryAccountId){
    const authorization=ownerAuthorization||await funds.access(conn,tenant,actor,{permission:'treasury.observe',session:tx,fence:true});
    const observed=await funds.requestObservationInSession(conn,tx,authorization,result.treasuryAccountId,{kind:'checkpoint',actualBalance:countAmount(declared,result.currency),observedAt:new Date().toISOString(),evidenceType:'cash_count',evidenceReference:`CASH-SHIFT:${result._id}:${(result.closeHistory||[]).length+1}`,note:reason||'Physical cash counted at closing.',idempotencyKey:randomUUID()});
    treasuryObservationId=observed.observation._id;
    if(ownerDirect)await confirmOwnerCount(conn,tx,authorization,treasuryObservationId,reason||'Owner counted and confirmed closing cash.');
   }
   result=await cashSessionModel(conn).findOneAndUpdate({_id:result._id,status:result.status},{$set:{
    declaredClosingMinor:decimal(declared),expectedClosingMinor:decimal(expected),varianceMinor:decimal(variance),submittedAt:new Date(),treasuryObservationId,
    ...(ownerDirect?{status:'approved',reviewedBy:id(actor.id),reviewedAt:new Date(),reviewNote:reason||'Owner confirmed closing cash.'}:{reviewedBy:null,reviewedAt:null,reviewNote:null})},
    ...(ownerDirect?{$unset:{activeKey:''}}:{}),$push:{closeHistory:{at:new Date(),actorId:id(actor.id),
    declaredMinor:decimal(declared),expectedMinor:decimal(expected),varianceMinor:decimal(variance),note:reason||'Cash counted'}}},
    {new:true,session:tx});
   await auditEventModel(conn).create([{action:ownerDirect?'mobile_money.shift.approved':'mobile_money.shift.submitted',actorId:id(actor.id),targetId:result._id,
    metadata:{branchId:String(result.branchId),currency:result.currency,varianceMinor:String(variance),ownerConfirmed:ownerDirect}}],{session:tx});
 });return result;
 }finally{await tx.endSession();}
}
async function decide(conn,tenant,actor,shiftId,input={},options={}){
 allowed(tenant,actor);if(!reviewer(actor))throw fail('Independent cash supervisors only',403);
 if(!['approve','dispute'].includes(input.decision))throw fail('Invalid decision');
 const ownerDirect=options.ownerDirect===true&&actor.role==='Tenant Owner'&&input.decision==='approve';
 const reason=note(input.note||(ownerDirect?'Owner confirmed the submitted physical cash count.':''));
 await ensureTenantIndexes(conn);
 const tx=await conn.startSession();let result;
 try{await tx.withTransaction(async()=>{
  result=await cashSessionModel(conn).findOneAndUpdate({_id:id(shiftId),status:'submitted',...(require('./reviewPolicy').canSelfReviewRoutine(actor,actor.branchId)?{}:{operatorId:{$ne:id(actor.id)}}),...scope(actor)},
   {$set:{status:input.decision==='approve'?'approved':'disputed',reviewedBy:id(actor.id),reviewedAt:new Date(),reviewNote:reason},
    ...(input.decision==='approve'?{$unset:{activeKey:''}}:{}),$inc:{revision:1}},
   {new:true,session:tx});
  if(!result)throw fail('Shift unavailable, outside your branch or owned by the reviewer',409);
  if(String(result.operatorId)===String(actor.id)&&
    !await require('./reviewPolicy').persistedRoutineReviewer(conn,tx,actor,result.branchId))
   throw fail('Self-review requires the current authorized owner or assigned manager role',403);
  // A Branch Manager may reconcile exact matches, but only a Tenant Owner or
  // Reconciliation Officer may accept a discrepancy. The transaction will
  // roll back when this authorization fails.
  if(!ownerDirect&&input.decision==='approve'&&minor(result.varianceMinor)!==0n&&
     (actor.role==='Branch Manager'||String(result.operatorId)===String(actor.id)))
   throw fail('Cash variance approvals require a Tenant Owner or Reconciliation Officer',403);
  if(ownerDirect){
   const funds=require('../treasury/service'),authorization=await funds.access(conn,tenant,actor,{permission:'treasury.review',session:tx,fence:true});
   if(result.treasuryObservationId)await confirmOwnerCount(conn,tx,authorization,result.treasuryObservationId,reason);
   else if(minor(result.varianceMinor)!==0n)throw fail('Link the shift to its cash account before recording a cash difference.',409);
  }else if(result.treasuryObservationId){
   const funds=require('../treasury/service'),authorization=await funds.access(conn,tenant,actor,{permission:'treasury.review',session:tx,fence:true});
   await funds.reviewObservationInSession(conn,tx,authorization,result.treasuryObservationId,{decision:input.decision==='approve'?'approve':'reject',note:reason});
  }
  await auditEventModel(conn).create([{action:`mobile_money.shift.${input.decision==='approve'?'approved':'disputed'}`,
   actorId:id(actor.id),targetId:result._id,metadata:{branchId:String(result.branchId),currency:result.currency,varianceMinor:String(result.varianceMinor),selfReviewed:String(result.operatorId)===String(actor.id),ownerConfirmed:ownerDirect}}],{session:tx});
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
async function reportRows({conn,filters,scope:filter,dateRange}){
 const match={createdAt:dateRange||mobile.dateBounds({from:filters.from,to:filters.to},filters.timeZone||'UTC'),
  // Aggregation pipelines do not apply Mongoose schema casting. CashSession
  // stores branchId as ObjectId, so a string would silently produce zero rows.
  ...require('../reporting/aggregateScope').branchMatch(filter, value=>new Types.ObjectId(value))};
 const rows=await cashSessionModel(conn).aggregate([{$match:match},
 {$group:{_id:{currency:'$currency',status:'$status'},count:{$sum:1},expected:{$sum:{$ifNull:['$expectedClosingMinor',0]}}}},
 {$sort:{'_id.currency':1,'_id.status':1}}]);
 return rows.map(r=>({module:'Mobile Money',activity:'Physical cash shifts',status:r._id.status,currency:r._id.currency,
 count:r.count,volume:mobile.formatMoneyMinor(r.expected||0,r._id.currency),fees:'N/A'}));
}
module.exports={allowed,bindFundAccount,refreshFundBalance,open,decideOpening,assertSmsWithinShift,assertSmsShiftTime,attachRecord,fenceRecordChange,submit,decide,list,detail,reportRows,key,activeFilter,minor,decimal,visibleScope,opener,reviewer};
