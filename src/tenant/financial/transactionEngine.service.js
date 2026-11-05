'use strict';
// INTERNAL-ONLY financial orchestration. No routes call this service. A provider
// adapter MUST independently verify the actual provider before emitting a
// signed, tenant-scoped normalized gateway envelope. HMAC is NOT a replacement
// for provider-specific callback/authentication and status-query verification.
const crypto = require('node:crypto');
const { Types } = require('mongoose');
const {
  branchModel,tenantUserModel,ledgerAccountModel,ledgerJournalModel,auditEventModel,
  financialOperationModel,financialEvidenceModel,financialExceptionModel,ensureTenantIndexes
} = require('../models');
const ledger = require('../services/ledger.service');
const {SOURCES,CURRENCIES} = require('./schemas');
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const REF = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{5,119}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{2,31}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_MINOR = 999999999999999999n;
const KINDS = Object.freeze({callback:'FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX',settlement:'FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX'});
function fail(message,status=400){ const e=new Error(message); e.status=status; return e; }
function oid(v,what){if(!OBJECT_ID.test(String(v||'')))throw fail(`Invalid ${what}`);return String(v).toLowerCase();}
function ref(v,what){if(typeof v!=='string'||!REF.test(v))throw fail(`Invalid ${what}`);return v;}
function provider(v){if(typeof v!=='string'||!PROVIDER.test(v))throw fail('Invalid provider code');return v;}
function minor(v){const s=String(v??'');if(!/^[1-9][0-9]{0,17}$/.test(s)||BigInt(s)>MAX_MINOR)throw fail('Invalid exact positive minor-unit amount');return s;}
function checkKeys(obj,keys){if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(obj,k)))throw fail('Invalid gateway envelope shape');}
function normalizeIntent(x){
  if(!x||typeof x!=='object'||!SOURCES.includes(x.sourceType)||!CURRENCIES.includes(x.currency))throw fail('Unsupported financial intent');
  const canonical={branchId:oid(x.branchId,'branch'),createdBy:oid(x.createdBy,'initiator'),
    sourceType:x.sourceType,sourceRef:ref(x.sourceRef,'source reference'),provider:provider(x.provider),
    providerRef:ref(x.providerRef,'provider reference'),currency:x.currency,amountMinor:minor(x.amountMinor)};
  const posted=ledger.validateJournal({branchId:canonical.branchId,actorId:canonical.createdBy,
    sourceType:canonical.sourceType,sourceRef:canonical.sourceRef,currency:canonical.currency,lines:x.ledgerLines});
  // Posting economics must correspond to expected external settlement amount.
  const total=posted.lines.reduce((sum,line)=>sum+(line.side==='debit'?BigInt(line.amountMinor):0n),0n);
  if(total!==BigInt(canonical.amountMinor))throw fail('Ledger journal amount differs from provider settlement amount');
  canonical.ledgerLines=posted.lines;
  return {...canonical,fingerprint:crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')};
}
async function authorized(conn,userId,branchId,roles,session){
  const u=await tenantUserModel(conn).findOne({_id:userId,status:'active'}).select('role branchId mfaEnabledAt').session(session).lean();
  if(!u||!roles.includes(u.role)||(u.role!=='Tenant Owner'&&String(u.branchId)!==branchId))throw fail('Financial role or branch permission denied',403);
  if(['Tenant Owner','Reconciliation Officer'].includes(u.role)&&!u.mfaEnabledAt)throw fail('Authenticator enrollment required for financial authorization',403);
  return u;
}
async function registerIntent(conn,input){
  const value=normalizeIntent(input);await ensureTenantIndexes(conn);
  const Operation=financialOperationModel(conn);
  const existing=await Operation.findOne({sourceType:value.sourceType,sourceRef:value.sourceRef}).lean();
  // Even duplicate reads require an active initiator and branch authorization.
  await authorized(conn,value.createdBy,value.branchId,
    value.sourceType==='mobile_money'?['Mobile Money Operator','Tenant Owner']:['Tenant Owner'],null);
  if(existing){if(existing.fingerprint!==value.fingerprint)throw fail('Financial reference reused with changed economics',409);return {operation:existing,duplicate:true};}
  const session=await conn.startSession();
  try{
    let operation;
    await session.withTransaction(async()=>{
      const branch=await branchModel(conn).findOneAndUpdate({_id:value.branchId,status:'active',currency:value.currency},
        {$inc:{revision:1}},{session,new:true}).lean();
      if(!branch)throw fail('Branch not active or currency mismatch',409);
      await authorized(conn,value.createdBy,value.branchId,
        value.sourceType==='mobile_money'?['Mobile Money Operator','Tenant Owner']:['Tenant Owner'],session);
      const accounts=await ledgerAccountModel(conn).find({branchId:value.branchId,currency:value.currency,
        code:{$in:value.ledgerLines.map(l=>l.accountCode)}}).session(session).lean();
      if(accounts.length!==value.ledgerLines.length)throw fail('Missing financial chart accounts',409);
      [operation]=await Operation.create([value],{session});
      await auditEventModel(conn).create([{action:'financial.intent.registered',actorId:value.createdBy,
        targetId:operation._id,metadata:{branchId:value.branchId,sourceType:value.sourceType,sourceRef:value.sourceRef}}],{session});
    });
    return {operation,duplicate:false};
  }catch(e){
    if(e.code===11000){const prior=await Operation.findOne({sourceType:value.sourceType,sourceRef:value.sourceRef}).lean();
      if(prior&&prior.fingerprint===value.fingerprint)return {operation:prior,duplicate:true};
      throw fail('Duplicate source or provider reference',409);}
    throw e;
  }finally{await session.endSession();}
}
function decodeKey(kind,env=process.env){
  if(!Object.hasOwn(KINDS,kind))throw fail('Unsupported gateway evidence kind');
  const raw=env[KINDS[kind]];
  if(typeof raw!=='string'||!/[0-9a-f]/i.test(raw)||raw.length<64||raw.length>128||raw.length%2||!/^[0-9a-f]+$/i.test(raw))
    throw fail(`Verified gateway signing key for ${kind} is not configured`,503);
  if(env[KINDS.callback]===env[KINDS.settlement])throw fail('Callback and statement signing keys must be different',503);
  return Buffer.from(raw,'hex');
}
const ENVELOPE_KEYS=['tenantDatabase','provider','kind','eventId','sourceType','sourceRef','providerRef',
  'currency','amountMinor','claimedStatus','issuedAt'];
function canonicalEvidence(payload,tenantDatabase,clock=Date.now()){
  checkKeys(payload,ENVELOPE_KEYS);
  const event={tenantDatabase:payload.tenantDatabase,provider:provider(payload.provider),kind:payload.kind,
    eventId:ref(payload.eventId,'event ID'),sourceType:payload.sourceType,
    sourceRef:ref(payload.sourceRef,'source reference'),providerRef:ref(payload.providerRef,'provider reference'),
    currency:payload.currency,amountMinor:minor(payload.amountMinor),claimedStatus:payload.claimedStatus,
    issuedAt:payload.issuedAt};
  if(event.tenantDatabase!==tenantDatabase||typeof tenantDatabase!=='string'||!tenantDatabase.startsWith('classicfin_'))throw fail('Wrong tenant gateway target',403);
  if(!Object.hasOwn(KINDS,event.kind)||!SOURCES.includes(event.sourceType)||!CURRENCIES.includes(event.currency))throw fail('Invalid gateway event classification');
  if(event.kind==='settlement'&&event.claimedStatus!=='confirmed')throw fail('Settlement statements must represent confirmed entries');
  if(event.kind==='callback'&&!['confirmed','failed'].includes(event.claimedStatus))throw fail('Invalid callback status');
  const timestamp=Date.parse(event.issuedAt);
  if(typeof event.issuedAt!=='string'||!Number.isFinite(timestamp)||new Date(timestamp).toISOString()!==event.issuedAt||
    Math.abs(clock-timestamp)>5*60*1000)throw fail('Gateway evidence timestamp expired or invalid',401);
  return {value:event,message:JSON.stringify(event)};
}
function authenticateEvidence(payload,signature,tenantDatabase,env=process.env,clock=Date.now()){
  const {value,message}=canonicalEvidence(payload,tenantDatabase,clock);
  if(typeof signature!=='string'||!DIGEST.test(signature))throw fail('Invalid evidence signature',401);
  const expected=crypto.createHmac('sha256',decodeKey(value.kind,env)).update(message).digest();
  if(!crypto.timingSafeEqual(Buffer.from(signature,'hex'),expected))throw fail('Untrusted gateway evidence',401);
  return {...value,digest:crypto.createHash('sha256').update(message).digest('hex')};
}
function evidenceMatchesOperation(ev,op){
  return Boolean(op&&op.sourceType===ev.sourceType&&op.sourceRef===ev.sourceRef&&
    op.provider===ev.provider&&op.providerRef===ev.providerRef&&
    op.currency===ev.currency&&String(op.amountMinor)===ev.amountMinor);
}
async function receiveEvidence(conn,{payload,signature},env=process.env){
  // The gateway must independently verify the real provider using its own API;
  // this step proves only that the approved gateway signed the normalized data.
  const ev=authenticateEvidence(payload,signature,conn.name,env);
  await ensureTenantIndexes(conn);
  const Evidence=financialEvidenceModel(conn),Operation=financialOperationModel(conn),Exception=financialExceptionModel(conn);
  const lookup={provider:ev.provider,kind:ev.kind,eventId:ev.eventId};
  const existing=await Evidence.findOne(lookup).lean();
  if(existing){if(existing.digest!==ev.digest)throw fail('Event reference reused with different evidence',409);return {evidence:existing,duplicate:true,exception:existing.matchStatus==='unmatched'};}
  const session=await conn.startSession();
  try{
    let saved, exception=false;
    await session.withTransaction(async()=>{
      const op=await Operation.findOne({sourceType:ev.sourceType,sourceRef:ev.sourceRef}).session(session).lean();
      const matching=evidenceMatchesOperation(ev,op);
      let code=!op?'UNKNOWN_OPERATION':!matching?'ECONOMICS_MISMATCH':null;
      if(matching&&ev.kind==='callback'){
        if(['reconciled','exception'].includes(op.status))code='STATE_CONFLICT';
        else if((op.status==='provider_failed'&&ev.claimedStatus==='confirmed')||
          (op.status==='provider_verified'&&ev.claimedStatus==='failed'))code='CONFLICTING_CALLBACK';
      }
      if(matching&&ev.kind==='settlement'){
        if(['provider_failed','exception'].includes(op.status))code='STATE_CONFLICT';
        else if(await Evidence.exists({operationId:op._id,kind:'settlement',
          claimedStatus:'confirmed',matchStatus:'matched'}).session(session))code='DUPLICATE_SETTLEMENT';
      }
      [saved]=await Evidence.create([{provider:ev.provider,kind:ev.kind,eventId:ev.eventId,
        sourceType:ev.sourceType,sourceRef:ev.sourceRef,providerRef:ev.providerRef,currency:ev.currency,
        amountMinor:ev.amountMinor,claimedStatus:ev.claimedStatus,issuedAt:new Date(ev.issuedAt),digest:ev.digest,
        operationId:op?op._id:null,matchStatus:code?'unmatched':'matched'}],{session});
      if(code){
        exception=true;
        await Exception.create([{branchId:op?op.branchId:null,operationId:op?op._id:null,evidenceId:saved._id,code}],{session});
        if(op&&op.status!=='reconciled'&&op.status!=='provider_failed'){
          await Operation.updateOne({_id:op._id,status:op.status},{$set:{status:'exception'}},{session});
        }
      }else if(ev.kind==='callback'&&op.status==='pending_verification'){
        await Operation.updateOne({_id:op._id,status:'pending_verification'},{$set:{
          status:ev.claimedStatus==='confirmed'?'provider_verified':'provider_failed',verifiedAt:new Date()
        }},{session});
      }
    });
    return {evidence:saved,duplicate:false,exception};
  }catch(e){
    if(e.code===11000){const prior=await Evidence.findOne(lookup).lean();
      if(prior&&prior.digest===ev.digest)return {evidence:prior,duplicate:true,exception:prior.matchStatus==='unmatched'};
      throw fail('Conflicting provider event reference',409);}
    throw e;
  }finally{await session.endSession();}
}
async function reconcileOperation(conn,{operationId,approvedBy}){
  const id=oid(operationId,'operation'), reviewer=oid(approvedBy,'reviewer');await ensureTenantIndexes(conn);
  const Operation=financialOperationModel(conn),Evidence=financialEvidenceModel(conn),Exception=financialExceptionModel(conn);
  const existing=await Operation.findById(id).lean();
  if(!existing)throw fail('Unknown financial operation',404);
  await authorized(conn,reviewer,String(existing.branchId),['Tenant Owner','Reconciliation Officer'],null);
  if(String(existing.createdBy)===reviewer)throw fail('An initiator cannot reconcile their own operation',403);
  if(existing.status==='reconciled')return {operation:existing,duplicate:true};
  const session=await conn.startSession();
  try{
    let result;
    await session.withTransaction(async()=>{
      const operation=await Operation.findById(id).session(session).lean();
      if(!operation||operation.status!=='provider_verified')throw fail('Only independently provider-verified records can be reconciled',409);
      await authorized(conn,reviewer,String(operation.branchId),['Tenant Owner','Reconciliation Officer'],session);
      if(await Exception.exists({operationId:operation._id,status:'open'}).session(session))throw fail('Unresolved financial exception blocks reconciliation',409);
      const proofs=await Evidence.find({operationId:operation._id,matchStatus:'matched',claimedStatus:'confirmed',
        kind:{$in:['callback','settlement']}}).session(session).lean();
      if(!proofs.some(p=>p.kind==='callback')||!proofs.some(p=>p.kind==='settlement'))throw fail('Both verified callback and settlement statement are required',409);
      const input=ledger.validateJournal({branchId:String(operation.branchId),actorId:reviewer,
        sourceType:operation.sourceType,sourceRef:operation.sourceRef,currency:operation.currency,
        lines:operation.ledgerLines.map(x=>({accountCode:x.accountCode,side:x.side,amountMinor:x.amountMinor}))});
      if(await ledgerJournalModel(conn).exists({sourceType:operation.sourceType,sourceRef:operation.sourceRef}).session(session))
        throw fail('Ledger has a separate posting for this financial source; investigate before recovery',409);
      const journal=await ledger.writeJournalInSession(conn,input,session);
      const updated=await Operation.findOneAndUpdate({_id:operation._id,status:'provider_verified',journalId:null},
        {$set:{status:'reconciled',reconciledAt:new Date(),journalId:journal._id}}, {session,new:true}).lean();
      if(!updated)throw fail('Concurrent reconciliation conflict',409);
      await auditEventModel(conn).create([{action:'financial.operation.reconciled',actorId:reviewer,
        targetId:operation._id,metadata:{branchId:String(operation.branchId),journalId:String(journal._id),
          sourceType:operation.sourceType,sourceRef:operation.sourceRef}}],{session});
      result={operation:updated,journal,duplicate:false};
    });
    return result;
  }catch(e){
    if(e.code===11000 || e.hasErrorLabel?.('TransientTransactionError')){
      const prior=await Operation.findById(id).lean();
      if(prior?.status==='reconciled'&&prior.journalId)return {operation:prior,duplicate:true};
    }
    throw e;
  }finally{await session.endSession();}
}
async function resolveException(conn,{exceptionId,reviewerId,note}){
  const id=oid(exceptionId,'exception'),reviewer=oid(reviewerId,'reviewer');
  if(typeof note!=='string'||note.trim().length<20||note.trim().length>400)throw fail('Provide a documented resolution of 20–400 characters');
  const Exception=financialExceptionModel(conn),Operation=financialOperationModel(conn),Evidence=financialEvidenceModel(conn);
  const found=await Exception.findById(id).lean();
  if(!found)throw fail('Financial exception not found',404);
  const op=found.operationId ? await Operation.findById(found.operationId).lean():null;
  if(found.operationId&&!op)throw fail('Financial operation missing',409);
  if(op){
    await authorized(conn,reviewer,String(op.branchId),['Tenant Owner','Reconciliation Officer'],null);
    if(String(op.createdBy)===reviewer)throw fail('Initiator cannot close their own exception',403);
  }else{
    // An orphan event has no trustworthy branch; only the tenant owner can close
    // its investigation, with MFA and a recorded reason. Never attach it to an
    // operation by guessing or create any financial posting.
    await authorized(conn,reviewer,'', ['Tenant Owner'],null);
  }
  const session=await conn.startSession();
  try{
    let closed;
    await session.withTransaction(async()=>{
      closed=await Exception.findOneAndUpdate({_id:id,status:'open'},{$set:{status:'closed',resolvedBy:reviewer,
        resolvedAt:new Date(),resolutionNote:note.trim()}},{session,new:true}).lean();
      if(!closed)throw fail('Exception already closed',409);
      await authorized(conn,reviewer,op?String(op.branchId):'',op?['Tenant Owner','Reconciliation Officer']:['Tenant Owner'],session);
      const remaining=op?await Exception.countDocuments({operationId:op._id,status:'open'}).session(session):0;
      if(op&&!remaining&&op.status==='exception'){
        // Only authenticated, matching affirmative callback evidence can restore
        // verification. Closing an exception never invents settlement evidence.
        const proof=await Evidence.exists({operationId:op._id,kind:'callback',claimedStatus:'confirmed',
          matchStatus:'matched'}).session(session);
        await Operation.updateOne({_id:op._id,status:'exception'},{$set:{status:proof?'provider_verified':'pending_verification'}},{session});
      }
      await auditEventModel(conn).create([{action:'financial.exception.resolved',actorId:reviewer,targetId:closed._id,
        metadata:{branchId:op?String(op.branchId):null,operationId:op?String(op._id):null,resolutionDigest:crypto.createHash('sha256').update(note.trim()).digest('hex')}}],{session});
    });
    return closed;
  }finally{await session.endSession();}
}
async function reconciliationSummary(conn,{branchId,olderThanHours=24}={}){
  const id=oid(branchId,'branch');
  if(!Number.isInteger(olderThanHours)||olderThanHours<1||olderThanHours>720)throw fail('Invalid review-age threshold');
  const Operation=financialOperationModel(conn),Exception=financialExceptionModel(conn),Evidence=financialEvidenceModel(conn);
  const age=new Date(Date.now()-olderThanHours*3600000);
  const [pending,providerVerified,failed,reconciled,exceptions,awaitingStatement]=await Promise.all([
    Operation.countDocuments({branchId:id,status:'pending_verification'}),
    Operation.countDocuments({branchId:id,status:'provider_verified'}),
    Operation.countDocuments({branchId:id,status:'provider_failed'}),
    Operation.countDocuments({branchId:id,status:'reconciled'}),
    Exception.countDocuments({branchId:id,status:'open'}),
    Operation.find({branchId:id,status:'provider_verified',createdAt:{$lt:age}}).sort({createdAt:1}).limit(100).select('_id').lean()
  ]);
  let staleWithoutStatement=0;
  for(const op of awaitingStatement){if(!(await Evidence.exists({operationId:op._id,kind:'settlement',matchStatus:'matched',claimedStatus:'confirmed'})))staleWithoutStatement++;}
  return {branchId:id,pending,providerVerified,failed,reconciled,openExceptions:exceptions,
    staleWithoutStatementSample:staleWithoutStatement,sampleLimit:100};
}
module.exports={normalizeIntent,canonicalEvidence,authenticateEvidence,evidenceMatchesOperation,
  registerIntent,receiveEvidence,reconcileOperation,resolveException,reconciliationSummary};
