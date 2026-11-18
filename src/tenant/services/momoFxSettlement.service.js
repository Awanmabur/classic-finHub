'use strict';
// Internal financial posting path; intentionally NOT mounted as an HTTP endpoint.
// Only call after a trusted integration verifies the provider event and cash
// handover. Arbitrary browser-supplied references are NOT verification.
const mongoose=require('mongoose');
const crypto=require('node:crypto');
const {records,grants,ensure:ensureFxIndexes}=require('../schemas/MomoFxSettlement');
const {models:treasuryModels,ensure:ensureTreasury}=require('../treasury/models');
const treasury=require('../treasury/service');
const {forexRateModel,branchModel,auditEventModel}=require('../models');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const {quote}=require('./momoFxQuote.service');
const OID=/^[a-f0-9]{24}$/i,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function fail(message,status=409){return Object.assign(new Error(message),{status});}
const ref=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{5,119}$/.test(value);
function expectedOperation(value){
 if(!['withdraw_provider_receive_cash','deposit_cash_send_provider'].includes(value))throw fail('Invalid exchange direction',400);
 return value;
}
function evidencePayload(proof){
 const {providerStatus,providerReference,network,currency,amountMinor,evidenceId,verifiedAt,cashConfirmedAt,cashHandoverConfirmed}=proof;
 return JSON.stringify({providerStatus,providerReference,network,currency,amountMinor,evidenceId,verifiedAt,cashConfirmedAt,cashHandoverConfirmed});
}
function requireEvidenceSignature(proof){
 const key=process.env.CLASSICFIN_MOMO_FX_PROVIDER_EVIDENCE_HMAC_KEY_HEX;
 if(typeof key!=='string'||!/^[a-f0-9]{64}$/i.test(key))
  throw fail('Verified provider evidence signer is not configured',503);
 if(typeof proof.evidenceSignature!=='string'||!/^[a-f0-9]{64}$/i.test(proof.evidenceSignature))
  throw fail('Authenticated provider evidence signature is required',403);
 const actual=crypto.createHmac('sha256',Buffer.from(key,'hex')).update('momo-fx-provider-v1|'+evidencePayload(proof)).digest();
 const supplied=Buffer.from(proof.evidenceSignature,'hex');
 if(!crypto.timingSafeEqual(actual,supplied))throw fail('Provider evidence signature is invalid',403);
}
function verifiedEvidence(proof,input){
 // The caller must be a trusted, internal provider-verification integration.
 // The HTTP layer must never construct proof from req.body.
 if(!proof||proof.providerStatus!=='confirmed'||proof.cashHandoverConfirmed!==true||
    !ref(proof.providerReference)||!ref(proof.evidenceId)||
    proof.providerReference!==input.providerReference||
    proof.network!==input.network||
    proof.currency!==input.providerCurrency||
    proof.amountMinor!==input.providerAmountMinor||
    !Number.isFinite(new Date(proof.verifiedAt).getTime())||
    !Number.isFinite(new Date(proof.cashConfirmedAt).getTime()))
  throw fail('Confirmed external provider evidence and physical cash handover are required');
 requireEvidenceSignature(proof);
 const verifiedAt=new Date(proof.verifiedAt),cashConfirmedAt=new Date(proof.cashConfirmedAt);
 if(verifiedAt>Date.now()+60000||cashConfirmedAt>Date.now()+60000||
    Date.now()-verifiedAt>86400000||Date.now()-cashConfirmedAt>86400000)
  throw fail('Provider or cash confirmation is stale');
 return {verifiedAt,cashConfirmedAt};
}
function operatorEvidence(proof,input,actor){
 // An authenticated cashier confirms both actual custody legs. This is a
 // finalized INTERNAL book entry; it never attests external provider settlement.
 if(!proof||proof.mode!=='operator_attested_unverified'||
    proof.actorId!==String(actor.id)||proof.providerReference!==input.providerReference||
    proof.providerAppConfirmed!==true||proof.cashHandoverConfirmed!==true)
  throw fail('Confirm the actual provider-app transaction and cash handover before recording',400);
 return {verifiedAt:null,cashConfirmedAt:new Date(),
  evidenceId:'OP:'+input.idempotencyKey,evidenceKind:'operator_attested',settlementState:'unverified'};
}
function dec(value){return mongoose.Types.Decimal128.fromString(String(value));}
async function settleVerified(conn,tenant,actor,input,proof){
 // Application-level kill switch, independent of tenant and branch grants.
 if(process.env.CLASSICFIN_MOMO_FX_POSTING_ENABLED!=='true')
  throw fail('Cross-currency financial posting is disabled',503);
 if(!tenant?._id||!actor?.id||!OID.test(String(input?.walletAccountId||''))||
    !OID.test(String(input?.cashAccountId||''))||!UUID.test(String(input?.idempotencyKey||''))||
    !ref(input.providerReference)||typeof input.network!=='string')
  throw fail('Invalid cross-currency operation identifiers',400);
 expectedOperation(input.operation);
 if(!hasModuleForUser(tenant,actor,'mobile_money')||!hasModuleForUser(tenant,actor,'forex')||
    !hasPermission(actor,'treasury.observe')||!(hasPermission(actor,'forex.view')||actor.role==='Mobile Money Operator')||
    !hasPermission(actor,'mobile_money.view'))throw fail('Missing cross-currency module or treasury permission',403);
 // Do not import signed external float movements from user supplied balances.
 const evidence=proof?.mode==='operator_attested_unverified'?
  operatorEvidence(proof,input,actor):
  {...verifiedEvidence(proof,input),evidenceId:proof.evidenceId,
   evidenceKind:'signed_provider',settlementState:'verified'};
 const Record=records(conn),Grant=grants(conn);
 await Promise.all([ensureTreasury(conn),ensureFxIndexes(conn)]);
 const existing=await Record.findOne({tenantId:tenant._id,idempotencyKey:input.idempotencyKey}).lean();
 if(existing){
  if(existing.providerReference!==input.providerReference||existing.network!==input.network||
     existing.operation!==input.operation||String(existing.actorId)!==String(actor.id)||
     String(existing.walletAccountId)!==input.walletAccountId||
     String(existing.cashAccountId)!==input.cashAccountId||
     String(existing.providerAmountMinor)!==input.providerAmountMinor)
    throw fail('Idempotency reference already used for another exchange');
  return {record:existing,duplicate:true};
 }
 const used=await Record.findOne({tenantId:tenant._id,network:input.network,
  providerReference:input.providerReference}).select('_id').lean();
 if(used)throw fail('This provider transaction reference is already recorded; never post it again');
 const session=await conn.startSession();
 try{
  let result;
  await session.withTransaction(async()=>{
   const branchId=String(input.branchId||'');
   if(!OID.test(branchId)||actor.role!=='Tenant Owner'&&String(actor.branchId)!==branchId)
    throw fail('Cross-branch settlement is forbidden',403);
   const auth=await treasury.access(conn,tenant,actor,{permission:'treasury.observe',sourceType:'forex',session,fence:true});
   const branch=await branchModel(conn).findOne({_id:branchId,status:'active'}).session(session).lean();
   if(!branch)throw fail('Branch is inactive');
   const pair=await treasuryModels(conn).account.find({
    _id:{$in:[input.walletAccountId,input.cashAccountId]},
    tenantId:tenant._id,branchId:branch._id,status:'active',
    openingApprovedAt:{$ne:null},reconciliationState:'matched'
   }).session(session).lean();
   const wallet=pair.find(row=>String(row._id)===input.walletAccountId&&row.kind==='wallet'&&row.network===input.network);
   const cash=pair.find(row=>String(row._id)===input.cashAccountId&&row.kind==='cash');
   if(!wallet||!cash||wallet.currency===cash.currency)throw fail('Verified wallet and cash drawer must have different currencies');
   for(const account of [wallet,cash])if(account.operatorId&&String(account.operatorId)!==String(actor.id))
    throw fail('Funds account belongs to a different cashier',403);
   // Write-fence the approved grant so concurrent suspension aborts the settlement.
   const grant=await Grant.findOneAndUpdate({tenantId:tenant._id,branchId:branch._id,
    walletAccountId:wallet._id,cashAccountId:cash._id,providerNetwork:wallet.network,
    permittedCurrencyPair:wallet.currency+'/'+cash.currency,status:'approved',
    expiresAt:{$gt:new Date()},providerAuthorizationReference:{$ne:''},
    regulatoryAuthorizationReference:{$ne:''},requestedBy:{$ne:null},
    approvedBy:{$ne:null},reviewedAt:{$ne:null}},
    {$inc:{revision:1}},{session,new:true}).lean();
   if(!grant||String(grant.requestedBy)===String(grant.approvedBy))
    throw fail('This branch/provider/currency pair lacks independently verified regulatory and provider authorization',403);
   const side=input.operation==='withdraw_provider_receive_cash'?'buy':'sell';
   const rate=await forexRateModel(conn).findOne({_id:input.rateId,
    branchId:branch._id,fromCurrency:wallet.currency,toCurrency:cash.currency,
    side,status:'active',reviewedBy:{$ne:null},expiresAt:{$gt:new Date()},
    revision:Number(input.rateVersion)}).session(session).lean();
   if(!rate)throw fail('Approved rate was replaced or expired; obtain a fresh quote');
   const q=quote({operation:input.operation,providerCurrency:wallet.currency,cashCurrency:cash.currency,
    providerAmountMinor:input.providerAmountMinor,rateDecimal:rate.rateDecimal,
    rateSide:rate.side,rateId:String(rate._id),rateVersion:rate.revision,
    approved:true,expiresAt:new Date(rate.expiresAt).toISOString()});
   if(q.cashAmountMinor!==String(input.cashAmountMinor)||
      input.providerCurrency!==wallet.currency||input.cashCurrency!==cash.currency||
      String(input.rateDecimal)!==rate.rateDecimal)throw fail('Submitted quote has changed; calculate the approved amounts again');
   const posting=await treasury.applyMovements(conn,session,auth,{
    sourceType:'forex',sourceRef:'MFX:'+input.idempotencyKey,branchId,
    operatingActorId:actor.id,
    legs:[{accountId:input.walletAccountId,deltaMinor:q.walletDeltaMinor},
          {accountId:input.cashAccountId,deltaMinor:q.cashDeltaMinor}],
    description:'Cross-currency Mobile Money '+input.operation+' ('+wallet.currency+'/'+cash.currency+')',
    evidenceReference:input.providerReference
   });
   // Both native-currency journals, account balances and this record commit
   // together. Missing FX cost basis is explicitly NOT shown as profit.
   const [record]=await Record.create([{
    tenantId:tenant._id,branchId:branch._id,actorId:actor.id,
    idempotencyKey:input.idempotencyKey,providerReference:input.providerReference,
    network:wallet.network,operation:input.operation,walletAccountId:wallet._id,
    cashAccountId:cash._id,providerCurrency:wallet.currency,cashCurrency:cash.currency,
    providerAmountMinor:dec(q.providerAmountMinor),cashAmountMinor:dec(q.cashAmountMinor),
    walletDeltaMinor:dec(q.walletDeltaMinor),cashDeltaMinor:dec(q.cashDeltaMinor),
    rateId:rate._id,rateVersion:rate.revision,rateSide:rate.side,rateDecimal:rate.rateDecimal,
    providerEvidenceId:evidence.evidenceId,providerVerifiedAt:evidence.verifiedAt,
    providerEvidenceKind:evidence.evidenceKind,providerSettlementState:evidence.settlementState,
    cashConfirmedAt:evidence.cashConfirmedAt,complianceGrantId:grant._id,
    journalBatchId:posting.batch._id,fxProfitState:'unmeasured_cost_basis',settledAt:new Date()
   }],{session});
   await auditEventModel(conn).create([{action:'mobile_money.fx.settled',actorId:actor.id,targetId:record._id,
    metadata:{branchId,providerReference:input.providerReference,providerCurrency:wallet.currency,
      cashCurrency:cash.currency,treasuryBatchId:String(posting.batch._id)}}],{session});
   result={record,duplicate:false};
  },{readConcern:{level:'snapshot'}});
  return result;
 }catch(error){
  if(error.code===11000)throw fail('This provider reference or exchange has already been recorded; reconcile before retrying');
  throw error;
 }finally{await session.endSession();}
}
async function settleManuallyConfirmed(conn,tenant,actor,input){
 const proof={mode:'operator_attested_unverified',actorId:String(actor?.id||''),
  providerReference:input?.providerReference,
  providerAppConfirmed:input?.providerAppConfirmed==='yes',
  cashHandoverConfirmed:input?.cashHandoverConfirmed==='yes'};
 if(!hasPermission(actor,input?.operation==='withdraw_provider_receive_cash'?'mobile_money.cash_out':'mobile_money.cash_in'))
  throw fail('Mobile Money transaction permission is required',403);
 return settleVerified(conn,tenant,actor,input,proof);
}
module.exports={settleVerified,settleManuallyConfirmed};
