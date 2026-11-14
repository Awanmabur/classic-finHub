'use strict';
const mongoose=require('mongoose');
const {model,ensure}=require('./networkTariffModels');
const {validateTariff,quote,NETWORKS}=require('./networkTariffs');
const workspace=require('../workspace/service');
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
 const allowed=['network','operation','currency','branchId','effectiveFrom','expiresAt','evidenceReference','bands','_csrf'];
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw fail('Unknown tariff input');
 const network=String(input.network||''),operation=String(input.operation||''),currency=String(input.currency||'');
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
 if(!NETWORKS[network]||NETWORKS[network].currency!==currency)throw fail('Choose the correct provider market and currency');
 return {network,operation,currency,branchId,effectiveFrom,expiresAt,evidenceReference:evidenceReference.trim(),tiers};
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
   const auth=await workspace.access(conn,tenant,actor,{manage:true,fence:true,session});
   if(details.branchId){
    const branch=await branchModel(conn).findOne({_id:details.branchId,status:'active'}).session(session).lean();
    if(!branch||!require('../services/branchCurrency.service').supports(branch,details.currency))throw fail('Choose an active branch that supports this currency',409);
   }
   const scope={tenantId:auth.tenant._id,branchId:details.branchId,network:details.network,currency:details.currency,operation:details.operation};
   // A duplicate draft must be reviewed or retired, never silently overwritten.
   const pending=await model(conn).findOne({...scope,status:'draft'}).session(session).lean();
   if(pending)throw fail('A draft schedule exists for this network and branch. Review it before submitting another.',409);
   const last=await model(conn).findOne(scope).sort({version:-1}).session(session).lean();
   [output]=await model(conn).create([{...scope,...details,version:(last?.version||0)+1,status:'draft',createdBy:auth.actor.id}],{session});
   await auditEventModel(conn).create([{actorId:auth.actor.id,action:'mobile_money.tariff.proposed',targetId:output._id,metadata:{network:details.network,operation:details.operation,currency:details.currency,version:output.version,evidenceReference:details.evidenceReference,branchId:String(details.branchId||'')}}],{session});
  });
  return output;
 }catch(e){if(e.code===11000)throw fail('The schedule changed concurrently. Reload and try again.',409);throw e;}finally{await session.endSession();}
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
     const other=await model(conn).findOne({_id:{$ne:prior._id},tenantId:auth.tenant._id,branchId:prior.branchId,network:prior.network,operation:prior.operation,currency:prior.currency,status:'approved'}).session(session).lean();
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
function preview(schedule,amountMinor){
 return quote({network:schedule.network,currency:schedule.currency,operation:schedule.operation,status:'draft',
   providerEvidence:schedule.evidenceReference,effectiveFrom:schedule.effectiveFrom,tiers:schedule.tiers},amountMinor);
}
module.exports={parseLines,serializeLines,validateInput,read,propose,decide,preview};
