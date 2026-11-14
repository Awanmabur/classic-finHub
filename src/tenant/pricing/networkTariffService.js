'use strict';
const mongoose=require('mongoose');
const {model,ensure}=require('./networkTariffModels');
const {validateTariff,quote,NETWORKS,SCHEDULE_KINDS}=require('./networkTariffs');
const treasury=require('../treasury/service');
const {branchModel,auditEventModel}=require('../models');
const OID=/^[a-f0-9]{24}$/i;
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function objectId(value){if(typeof value!=='string'||!OID.test(value))throw fail('Invalid tariff record');return new mongoose.Types.ObjectId(value);}
function parseLines(lines){
 if(typeof lines!=='string'||lines.length>30000)throw fail('Enter no more than 30 KB of tariff bands');
 const rows=lines.trim().split(/\r?\n/).filter(Boolean);
 if(rows.length<1||rows.length>250)throw fail('Enter 1–250 tariff bands');
 return rows.map((line,n)=>{
   const bits=line.split(',').map(s=>s.trim());
   if(bits.length!==4||bits.some(s=>!s))throw fail('Line '+(n+1)+': enter minimum, maximum, flat or basis_points, rate');
   const [minMinor,maxMinor,kind,value]=bits;
   return {minMinor,maxMinor,rate:{kind,value}};
 });
}
function serializeLines(tiers){return tiers.map(t=>[t.minMinor,t.maxMinor,t.rate.kind,t.rate.value].join(', ')).join('\n');}
function validateInput(input){
 const allowed=['network','operation','scheduleKind','currency','walletAccountId','branchId','effectiveFrom','expiresAt','evidenceReference','bands','_csrf'];
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw fail('Unknown tariff input');
 const network=String(input.network||''),operation=String(input.operation||''),currency=NETWORKS[String(input.network||'')]?.currency||String(input.currency||''),scheduleKind=String(input.scheduleKind||'');
 if(NETWORKS[network]?.currency&&input.currency&&input.currency!==currency)throw fail('Currency cannot be changed independently of the selected provider market',409);
 const walletAccountId=NETWORKS[network]&&!NETWORKS[network].currency?objectId(input.walletAccountId):null;
 if(!SCHEDULE_KINDS.includes(scheduleKind))throw fail('Choose whether this is a customer network fee or agent commission.');
 if(!input.branchId)throw fail('Choose the branch whose agent accounts use this commission schedule');
 const branchId=objectId(input.branchId);
 const evidenceReference=input.evidenceReference;
 if(typeof evidenceReference!=='string'||evidenceReference.trim().length<12||evidenceReference.trim().length>350||/[\u0000-\u001f\u007f]/.test(evidenceReference))throw fail('Provide a tariff provider document, agreement or statement reference (12–350 characters)');
 const date=(value,label)=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw fail('Enter a valid '+label+' (YYYY-MM-DD)');
  const parsed=new Date(value+'T00:00:00.000Z');
  if(!Number.isFinite(parsed.valueOf())||parsed.toISOString().slice(0,10)!==value)throw fail('Invalid '+label);
  return parsed;
 };
 const effectiveFrom=date(input.effectiveFrom,'effective date');
 const expiresAt=input.expiresAt?date(input.expiresAt,'expiry date'):null;
 if(expiresAt&&expiresAt<=effectiveFrom)throw fail('Expiry must follow the effective date');
 const tiers=parseLines(input.bands);
 validateTariff({network,operation,currency,status:'draft',tiers});
 // Reject impossible cross-network currency before persisting.
 if(!NETWORKS[network]||(NETWORKS[network].currency&&NETWORKS[network].currency!==currency))throw fail('Choose the correct provider market and currency');
 return {network,operation,scheduleKind,currency,branchId,...(walletAccountId?{walletAccountId}:{}),effectiveFrom,expiresAt,evidenceReference:evidenceReference.trim(),tiers};
}
async function read(conn,tenant,actor){
 const auth=await treasury.access(conn,tenant,actor,{permission:'treasury.view',sourceType:'mobile_money'});
 const filter={tenantId:auth.tenant._id};
 if(!['Tenant Owner','Auditor'].includes(auth.actor.role))filter.branchId=objectId(String(auth.actor.branchId));
 const rows=await model(conn).find(filter).sort({createdAt:-1}).limit(300).lean();
 return rows;
}
async function propose(conn,tenant,actor,input){
 const details=validateInput(input);
 await ensure(conn);
 const session=await conn.startSession();
 try{
  let output;
  await session.withTransaction(async()=>{
   const auth=await treasury.access(conn,tenant,actor,{permission:'treasury.observe',sourceType:'mobile_money',session,fence:true});
   if(!['Tenant Owner','Mobile Money Operator'].includes(auth.actor.role))throw fail('Only authorized agent operators may propose rate sheets',403);
   if(auth.actor.role==='Mobile Money Operator'&&String(details.branchId)!==String(auth.actor.branchId))throw fail('Rate sheets must belong to your assigned branch',403);
   if(details.branchId){
    const branch=await branchModel(conn).findOne({_id:details.branchId,status:'active'}).session(session).lean();
    if(!branch||!require('../services/branchCurrency.service').supports(branch,details.currency))throw fail('Choose an active branch that supports this currency',409);
   }
   if(details.walletAccountId){
    // An ambiguous provider name is not a market. The existing, reviewed branch
    // wallet supplies the allowed currency; no operator-entered currency is trusted.
    const wallet=await require('../treasury/models').models(conn).account.findOne({
      _id:details.walletAccountId,tenantId:auth.tenant._id,branchId:details.branchId,
      network:details.network,currency:details.currency,kind:'wallet',status:'active',
      openingApprovedAt:{$ne:null},reconciliationState:'matched'
    }).session(session).lean();
    if(!wallet)throw fail('Choose an active, independently reconciled wallet for this provider market and currency',409);
   }
   const scope={tenantId:auth.tenant._id,branchId:details.branchId,network:details.network,currency:details.currency,operation:details.operation,scheduleKind:details.scheduleKind};
   // A duplicate draft must be reviewed or retired, never silently overwritten.
   const pending=await model(conn).findOne({...scope,status:'draft'}).session(session).lean();
   if(pending)throw fail('A draft schedule exists for this network and branch. Review it before submitting another.',409);
   const last=await model(conn).findOne(scope).sort({version:-1}).session(session).lean();
   const {walletAccountId:marketWalletId,...storedDetails}=details;
   [output]=await model(conn).create([{...scope,...storedDetails,version:(last?.version||0)+1,status:'draft',createdBy:auth.actor.id}],{session});
   await auditEventModel(conn).create([{actorId:auth.actor.id,action:'mobile_money.tariff.proposed',targetId:output._id,metadata:{network:details.network,operation:details.operation,currency:details.currency,scheduleKind:details.scheduleKind,version:output.version,evidenceReference:details.evidenceReference,branchId:String(details.branchId||'')}}],{session});
  });
  return output;
 }catch(e){if(e.code===11000)throw fail('The schedule changed concurrently. Reload and try again.',409);throw e;}finally{await session.endSession();}
}
async function revise(conn,tenant,actor,id,input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['bands','evidenceReference','revision','_csrf'].includes(k)))throw fail('Unrecognized tariff edit');
 const expected=Number(input.revision);
 if(!/^(?:0|[1-9][0-9]{0,8})$/.test(String(input.revision))||!Number.isSafeInteger(expected))throw fail('Invalid tariff revision. Reload the sheet.',409);
 const tiers=parseLines(input.bands);
 const evidenceReference=input.evidenceReference;
 if(typeof evidenceReference!=='string'||evidenceReference.trim().length<12||evidenceReference.trim().length>350||/[\u0000-\u001f\u007f]/.test(evidenceReference))throw fail('Provide a valid provider document reference');
 const session=await conn.startSession();
 try{
  let output;
  await session.withTransaction(async()=>{
   const auth=await workspace.access(conn,tenant,actor,{manage:true,fence:true,session});
   const prior=await model(conn).findOne({_id:objectId(id),tenantId:auth.tenant._id,status:'draft',revision:expected}).session(session).lean();
   if(!prior)throw fail('Draft changed or was already approved. Reload the page.',409);
   if(auth.actor.role==='Mobile Money Operator'&&
     (String(prior.branchId)!==String(auth.actor.branchId)||String(prior.createdBy)!==auth.actor.id))
     throw fail('Only the original agent may edit their branch draft',403);
   validateTariff({network:prior.network,currency:prior.currency,operation:prior.operation,status:'draft',tiers});
   output=await model(conn).findOneAndUpdate({_id:prior._id,tenantId:auth.tenant._id,status:'draft',revision:expected},
    {$set:{tiers,evidenceReference:evidenceReference.trim()},$inc:{revision:1}},{session,new:true,runValidators:true}).lean();
   if(!output)throw fail('Draft changed while saving. Reload.',409);
   await auditEventModel(conn).create([{actorId:auth.actor.id,action:'mobile_money.tariff.revised',targetId:prior._id,
    metadata:{network:prior.network,operation:prior.operation,currency:prior.currency,scheduleKind:prior.scheduleKind,version:prior.version,revision:output.revision}}],{session});
  });
  return output;
 }finally{await session.endSession();}
}
async function decide(conn,tenant,actor,id,decision){
 if(!['approve','retire'].includes(decision))throw fail('Choose a valid tariff decision');
 await ensure(conn);
 const session=await conn.startSession();
 try{
  let output;
  await session.withTransaction(async()=>{
   const auth=await treasury.access(conn,tenant,actor,{permission:'treasury.review',sourceType:'mobile_money',session,fence:true});
   if(!['Tenant Owner','Reconciliation Officer'].includes(auth.actor.role))throw fail('Independent tariff reviewer required',403);
   const prior=await model(conn).findOne({_id:objectId(id),tenantId:auth.tenant._id}).session(session).lean();
   if(!prior)throw fail('Tariff not found',404);
   if(auth.actor.role!=='Tenant Owner'&&String(prior.branchId||'')!==String(auth.actor.branchId||''))throw fail('Reviewer belongs to a different branch',403);
   if(String(prior.createdBy)===auth.actor.id)throw fail('The proposer cannot approve or retire their own schedule',403);
   if(decision==='approve'&&prior.status!=='draft'||decision==='retire'&&prior.status!=='approved')throw fail('Tariff already processed or wrong status',409);
   if(decision==='approve'){
     validateTariff({network:prior.network,operation:prior.operation,currency:prior.currency,status:'draft',tiers:prior.tiers});
     const other=await model(conn).findOne({_id:{$ne:prior._id},tenantId:auth.tenant._id,branchId:prior.branchId,network:prior.network,operation:prior.operation,currency:prior.currency,scheduleKind:prior.scheduleKind,status:'approved'}).session(session).lean();
     if(other)throw fail('An approved schedule already exists. Retire the old schedule before approving the replacement.',409);
   }
   const updates=decision==='approve'?{status:'approved',approvedAt:new Date(),approvedBy:auth.actor.id}:{status:'retired',retiredAt:new Date(),retiredBy:auth.actor.id};
   output=await model(conn).findOneAndUpdate({_id:prior._id,tenantId:auth.tenant._id,status:prior.status,revision:prior.revision},{$set:updates,$inc:{revision:1}},{session,new:true,runValidators:true}).lean();
   if(!output)throw fail('The tariff changed. Reload it before reviewing.',409);
   await auditEventModel(conn).create([{actorId:auth.actor.id,action:'mobile_money.tariff.'+(decision==='approve'?'approved':'retired'),targetId:prior._id,metadata:{network:prior.network,currency:prior.currency,operation:prior.operation,version:prior.version}}],{session});
  });
  return output;
 }finally{await session.endSession();}
}
async function transactionEstimates(conn,tenant,branch,{network,currency,operation,amountMinor,at=new Date(),session=null}){
 const timestamp=new Date(at);
 if(!Number.isFinite(timestamp.getTime()))throw fail('Invalid operation date');
 const result={agentCommissionEstimate:null,customerNetworkFeeEstimate:null};
 for(const scheduleKind of ['agent_commission','customer_network_fee']){
  const query=model(conn).findOne({
   tenantId:tenant._id,branchId:branch._id,network,currency,operation,scheduleKind,
   status:'approved',effectiveFrom:{$lte:timestamp},$or:[{expiresAt:null},{expiresAt:{$gt:timestamp}}]
  }).sort({version:-1});
  if(session)query.session(session);
  const rule=await query.lean();
  if(!rule)continue;
  const quoted=preview(rule,String(amountMinor));
  if(quoted.status==='no_matching_band')continue;
  const amount=scheduleKind==='agent_commission'?quoted.grossCommissionEstimateMinor:quoted.customerNetworkChargeEstimateMinor;
  if(amount===undefined||amount===null)continue;
  const snapshot={scheduleId:rule._id,version:rule.version,scheduleKind,network,operation,currency,
   amountMinor:String(amount),quotedAt:timestamp,status:'estimated_not_received'};
  result[scheduleKind==='agent_commission'?'agentCommissionEstimate':'customerNetworkFeeEstimate']=snapshot;
 }
 return result;
}
function preview(schedule,amountMinor){
 const calculated=quote({network:schedule.network,currency:schedule.currency,operation:schedule.operation,status:'draft',
   providerEvidence:schedule.evidenceReference,effectiveFrom:schedule.effectiveFrom,tiers:schedule.tiers},amountMinor);
 if(schedule.scheduleKind==='customer_network_fee'){
  const {grossCommissionEstimateMinor,...safe}=calculated;
  return {...safe,customerNetworkChargeEstimateMinor:grossCommissionEstimateMinor??null};
 }
 return calculated;
}
module.exports={parseLines,serializeLines,validateInput,read,propose,revise,decide,preview,transactionEstimates};
