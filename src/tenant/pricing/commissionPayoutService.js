'use strict';
const mongoose=require('mongoose');
const treasury=require('../treasury/service');
const {model,ensure}=require('./commissionPayoutModels');
const {auditEventModel}=require('../models');
const {networks}=require('../../config/mobileNetworks');
const OID=/^[a-f0-9]{24}$/i;
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function oid(value){if(typeof value!=='string'||!OID.test(value))throw fail('Choose a valid funds account or commission record');return new mongoose.Types.ObjectId(value);}
function text(value,label,min,max){
 if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||/[<>\u0000-\u001f\u007f]/.test(value))throw fail('Enter valid '+label);
 return value.trim();
}
function validate(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['walletAccountId','network','currency','providerReference','statementEvidence','amount','grossAmount','taxWithheld','providerCost','creditedAt','_csrf'].includes(k)))throw fail('Unknown payout field');
 const network=input.network,currency=input.currency;
 if(!networks.includes(network))throw fail('Choose a valid Mobile Money network');
 const networkConfig=require('./networkTariffs').NETWORKS[network];
 if(!networkConfig||(networkConfig.currency&&networkConfig.currency!==currency)||(!networkConfig.currency&&!require('../../config/currencies').currencyCodes.includes(currency)))throw fail('Provider network and payout currency do not match the configured market. Select a reconciled network wallet first.');
 const providerReference=text(input.providerReference,'provider commission reference',6,120);
 if(!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(providerReference))throw fail('Use a valid statement reference');
 const statementEvidence=text(input.statementEvidence,'provider payout evidence',12,350);
 // This is a received payout, not a fee quote; accept only strictly positive exact amount.
 const amountMinor=require('../treasury/service').major(input.amount,currency);
 if(amountMinor<=0n)throw fail('Commission payout must be greater than zero');
 const grossMinor=treasury.major(input.grossAmount,currency),taxWithheldMinor=treasury.major(input.taxWithheld??'0',currency),providerCostMinor=treasury.major(input.providerCost??'0',currency);
 if(grossMinor<=0n||grossMinor!==amountMinor+taxWithheldMinor+providerCostMinor)throw fail('Gross commission must equal amount credited plus withheld taxes and network costs. Verify the provider statement.');
 if(typeof input.creditedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.creditedAt))throw fail('Enter the actual provider credit date and time');
 const creditedAt=new Date(input.creditedAt+':00.000Z');
 if(!Number.isFinite(creditedAt.valueOf())||creditedAt.toISOString().slice(0,16)!==input.creditedAt||
   creditedAt>Date.now()+60000||creditedAt<Date.now()-30*86400000)throw fail('Provider credit date must be within the last 30 days (UTC)');
 return {walletAccountId:oid(input.walletAccountId),network,currency,providerReference,statementEvidence,amountMinor:String(amountMinor),grossMinor:String(grossMinor),taxWithheldMinor:String(taxWithheldMinor),providerCostMinor:String(providerCostMinor),creditedAt};
}
async function list(conn,tenant,actor){
 const auth=await treasury.access(conn,tenant,actor,{permission:'treasury.view',sourceType:'mobile_money'});
 const filter={tenantId:auth.tenant._id};
 if(!['Tenant Owner','Auditor'].includes(auth.actor.role))filter.branchId=oid(String(auth.actor.branchId||''));
 const [records,accounts]=await Promise.all([
  model(conn).find(filter).sort({createdAt:-1}).limit(100).lean(),
  treasury.findOperatingAccounts(conn,tenant,actor,{moduleKey:'mobile_money'})
 ]);
 const wallets=accounts.filter(a=>a.kind==='wallet'&&a.status==='active'&&a.openingBalanceMinor!==null&&a.openingApprovedAt&&a.reconciliationState==='matched');
 const allowed=new Set(accounts.filter(a=>a.kind==='wallet').map(a=>String(a._id)));
 return {records:records.filter(r=>allowed.has(String(r.walletAccountId))),wallets};
}
async function summary(conn,tenant,actor){
 const auth=await treasury.access(conn,tenant,actor,{permission:'treasury.view',sourceType:'mobile_money'});
 const match={tenantId:auth.tenant._id,status:'posted'};
 if(!['Tenant Owner','Auditor'].includes(auth.actor.role))match.branchId=oid(String(auth.actor.branchId||''));
 const groups=await model(conn).aggregate([{$match:match},{$group:{
  _id:{network:'$network',currency:'$currency'},
  receivedMinor:{$sum:{$toDecimal:'$amountMinor'}},
  count:{$sum:1}
 }},{$sort:{'_id.network':1,'_id.currency':1}}]);
 return groups.map(g=>({network:g._id.network,currency:g._id.currency,
  receivedMinor:String(g.receivedMinor),count:g.count}));
}
async function propose(conn,tenant,actor,input){
 const values=validate(input);await ensure(conn);
 const session=await conn.startSession();
 try{
  let created;
  await session.withTransaction(async()=>{
   const auth=await treasury.access(conn,tenant,actor,{permission:'treasury.observe',sourceType:'mobile_money',session,fence:true});
   if(!['Tenant Owner','Mobile Money Operator'].includes(auth.actor.role))throw fail('Only the agent or tenant owner may submit payout evidence',403);
   const wallet=await treasury.loadAccount(conn,auth,values.walletAccountId,{session});
   if(wallet.kind!=='wallet'||wallet.network!==values.network||wallet.currency!==values.currency||
      wallet.status!=='active'||!wallet.openingApprovedAt||wallet.reconciliationState!=='matched')throw fail('Select an active, reconciled provider commission wallet with the correct network and currency',409);
   if(wallet.operatorId&&String(wallet.operatorId)!==auth.actor.id&&auth.actor.role!=='Tenant Owner')throw fail('This wallet belongs to a different agent',403);
   if(wallet.feeTreatment!=='record_only')throw fail('Existing wallet fee recognition must be separated before recording provider payouts. Set wallet fee treatment to record only and reconcile historical commissions first.',409);
   [created]=await model(conn).create([{tenantId:auth.tenant._id,branchId:wallet.branchId,...values,createdBy:auth.actor.id}],{session});
   await auditEventModel(conn).create([{actorId:auth.actor.id,action:'mobile_money.commission_payout.submitted',targetId:created._id,metadata:{
    network:values.network,branchId:String(wallet.branchId),currency:values.currency,amountMinor:values.amountMinor,providerReference:values.providerReference}}],{session});
  });
  return created;
 }catch(e){if(e.code===11000)throw fail('This provider commission reference has already been recorded for this wallet',409);throw e;}finally{await session.endSession();}
}
async function review(conn,tenant,actor,id,input){
 const decision=input?.decision;
 if(!['approve','reject'].includes(decision))throw fail('Choose a payout decision');
 const note=text(input?.note,'review reason',12,400);
 await ensure(conn);
 const session=await conn.startSession();
 try{
  let result;
  await session.withTransaction(async()=>{
   const auth=await treasury.access(conn,tenant,actor,{permission:'treasury.review',sourceType:'mobile_money',session,fence:true});
   if(!['Tenant Owner','Reconciliation Officer'].includes(auth.actor.role))throw fail('Independent reviewer required',403);
   const prior=await model(conn).findOne({_id:oid(id),tenantId:auth.tenant._id,status:'pending_review'}).session(session).lean();
   if(!prior)throw fail('Payout missing or already reviewed',409);
   if(String(prior.createdBy)===auth.actor.id)throw fail('The payout submitter cannot approve their own financial entry',403);
   if(auth.actor.role!=='Tenant Owner'&&String(auth.actor.branchId)!==String(prior.branchId))throw fail('Payout is outside your assigned branch',403);
   const account=await treasury.loadAccount(conn,auth,prior.walletAccountId,{session});
   if(account.kind!=='wallet'||String(account.branchId)!==String(prior.branchId)||account.network!==prior.network||account.currency!==prior.currency||account.feeTreatment!=='record_only')throw fail('Provider wallet configuration changed',409);
   let posting=null;
   if(decision==='approve'){
    if(process.env.ENABLE_MOMO_COMMISSION_POSTING!=='true')throw fail('Commission posting is locked until the legacy fee reconciliation and staging release gate are approved.',503);
    if(BigInt(prior.taxWithheldMinor)!==0n||BigInt(prior.providerCostMinor)!==0n)throw fail('Tax withholding or network deductions require a verified accounting policy before commission posting. Preserve this evidence without changing balances.',409);
    if(account.status!=='active'||!account.openingApprovedAt||account.reconciliationState!=='matched')throw fail('Provider wallet must be reconciled before posting commission',409);
    // Historical wallet commissions may have already credited fee income.
    // Refuse a new provider payout until legacy recognition has been reconciled.
    const recorded=await require('../models').mobileTransactionModel(conn).exists({
      walletAccountId:account._id,feeTreatment:'wallet_commission',
      feeMinor:{$gt:mongoose.Types.Decimal128.fromString('0')},
      status:{$ne:'voided_internal'},correctionState:{$ne:'voided'}
    }).session(session);
    if(recorded)throw fail('Historical wallet commissions exist for this account. Reconcile and migrate those entries before posting a provider payout to avoid duplicate revenue.',409);
    const income=await treasury.ensureCounterAccount(conn,session,{tenantId:auth.tenant._id,branchId:prior.branchId,currency:prior.currency,purpose:'agent_commission_income',actorId:auth.actor.id});
    posting=await treasury.applyMovements(conn,session,auth,{
      sourceType:'mobile_money',sourceRef:'MCOM:'+String(prior._id),
      branchId:String(prior.branchId),
      operatingActorId:String(account.operatorId||auth.actor.id),
      legs:[{accountId:String(account._id),deltaMinor:prior.amountMinor}],
      ledgerLines:[{currency:prior.currency,accountId:String(income.ledgerAccountId),side:'credit',amountMinor:prior.amountMinor}],
      description:'Provider commission paid: '+prior.network+' '+prior.providerReference,
      evidenceReference:prior.providerReference,
      occurredAt:prior.creditedAt
    });
    if(!posting?.batch?._id||!Array.isArray(posting.journalIds)||posting.journalIds.length===0||posting.duplicate)throw fail('Commission payout lacks a newly committed balanced journal. No income was recognized.',503);
   }
   result=await model(conn).findOneAndUpdate({_id:prior._id,tenantId:auth.tenant._id,status:'pending_review'},
     {$set:{status:decision==='approve'?'posted':'rejected',reviewedBy:auth.actor.id,reviewedAt:new Date(),reviewNote:note,journalBatchId:posting?.batch?._id||null}},
     {session,new:true,runValidators:true}).lean();
   if(!result)throw fail('Payout changed while reviewing. Reload.',409);
   await auditEventModel(conn).create([{actorId:auth.actor.id,action:'mobile_money.commission_payout.'+(decision==='approve'?'posted':'rejected'),
     targetId:prior._id,metadata:{network:prior.network,branchId:String(prior.branchId),currency:prior.currency,amountMinor:prior.amountMinor,
      providerReference:prior.providerReference,journalBatchId:String(result.journalBatchId||'')}}],{session});
  });
  return result;
 }finally{await session.endSession();}
}
module.exports={validate,list,summary,propose,review};
