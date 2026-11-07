'use strict';
// Funding transfers move existing assets. They never manufacture a balance or
// replace independently reviewed actual observations.
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const treasury=require('./service');
const {model,ensureIndexes}=require('./funding.models');
const core=require('../models');
const {trustedActor}=require('../services/financialAuthorization.service');
const {resolveTransactionBranch}=require('../services/transactionBranch.service');
const {hasModuleForUser}=require('../services/moduleAccess.service');
const OID=/^[a-f0-9]{24}$/i,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KINDS=['cash','bank','wallet'];
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function id(value){if(!OID.test(String(value||'')))throw fail('Select a valid funding account');return String(value).toLowerCase();}
function text(value,label,min,max){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||/[<>\u0000-\u001f\u007f]/.test(value))throw fail(`Enter a valid ${label}`);return value.trim();}
function hash(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
async function transaction(conn,fn){const session=await conn.startSession();try{let result;await session.withTransaction(async()=>{result=await fn(session);},{readConcern:{level:'snapshot'}});return result;}finally{await session.endSession();}}
async function audit(conn,session,actor,action,row){await core.auditEventModel(conn).create([{action,actorId:actor.id,targetId:row._id,metadata:{branchId:String(row.branchId),currency:row.currency,sourceAccountId:String(row.sourceAccountId),destinationAccountId:String(row.destinationAccountId),amountMinor:String(row.amountMinor)}}],{session});}
function validatePair(source,destination,branchId,{ready=true}={}){
 if(String(source._id)===String(destination._id))throw fail('Choose different source and destination accounts');
 if(!KINDS.includes(source.kind)||!KINDS.includes(destination.kind))throw fail('Funding transfers support cash, bank and wallet accounts');
 if(source.currency!==destination.currency||String(source.branchId)!==String(destination.branchId)||String(source.branchId)!==String(branchId))throw fail('Funding accounts must use the same operating branch and currency',409);
 if(ready)for(const account of [source,destination])if(account.status!=='active'||account.openingBalanceMinor===null||!account.openingApprovedAt||account.reconciliationState!=='matched')throw fail('Both funding accounts need approved opening balances and resolved reconciliation',409);
}
async function operatingActor(conn,session,authorization,source,destination){
 const assigned=[...new Set([source.operatorId,destination.operatorId].filter(Boolean).map(String))];
 if(assigned.length>1)throw fail('Funding cannot combine different operators’ assigned accounts',403);
 const operatorId=assigned[0]||authorization.actor.id;
 if(operatorId!==authorization.actor.id&&authorization.actor.role!=='Tenant Owner')throw fail('Use funding accounts assigned to your own account',403);
 const person=await core.tenantUserModel(conn).findOne({_id:operatorId,status:'active'}).session(session).lean();
 if(!person)throw fail('The assigned funding operator is unavailable',403);
 const actor=trustedActor(person);
 if(actor.role!=='Tenant Owner'&&String(actor.branchId)!==String(source.branchId))throw fail('The assigned funding operator belongs to a different branch',403);
 const trusted=await treasury.access(conn,authorization.tenant,actor,{permission:'treasury.observe',session,fence:true});
 for(const account of [source,destination])if(account.moduleKey!=='shared'&&!hasModuleForUser(trusted.tenant,trusted.actor,account.moduleKey))throw fail('The assigned operator needs access to the underlying funds module',403);
 return trusted.actor;
}
async function pair(conn,session,authorization,input){
 const source=await treasury.loadAccount(conn,authorization,input.sourceAccountId,{session,fence:true});
 const destination=await treasury.loadAccount(conn,authorization,input.destinationAccountId,{session,fence:true});
 return {source,destination};
}
async function request(conn,tenant,actor,input={}){
 const values={sourceAccountId:id(input.sourceAccountId),destinationAccountId:id(input.destinationAccountId),evidenceReference:text(input.evidenceReference,'funding reference',6,120),note:text(input.note,'funding explanation',12,400),idempotencyKey:input.idempotencyKey};
 if(typeof values.idempotencyKey!=='string'||!UUID.test(values.idempotencyKey))throw fail('Reload to obtain a valid funding request reference');values.idempotencyKey=values.idempotencyKey.toLowerCase();
 await Promise.all([treasury.ensure(conn),ensureIndexes(conn)]);
 let fingerprint;
 try{return await transaction(conn,async session=>{
  const authorization=await treasury.access(conn,tenant,actor,{permission:'treasury.observe',session,fence:true});
  const Branch={findOne:query=>core.branchModel(conn).findOne(query).session(session),find:query=>core.branchModel(conn).find(query).session(session)};
  const {source,destination}=await pair(conn,session,authorization,values);
  const branch=authorization.actor.role==='Tenant Owner'?await core.branchModel(conn).findOne({_id:source.branchId,status:'active'}).session(session).lean():await resolveTransactionBranch(conn,authorization.actor,{}, {Branch});
  if(!branch)throw fail('The funding branch is inactive or unavailable',409);
  validatePair(source,destination,branch._id,{ready:false});
  const amount=treasury.major(input.amount,source.currency);if(amount<=0n)throw fail('Funding amount must be greater than zero');
  const operating=await operatingActor(conn,session,authorization,source,destination);
  const canonical={...values,tenantId:String(authorization.tenant._id),branchId:String(branch._id),currency:source.currency,amountMinor:String(amount),requestedBy:authorization.actor.id,requestedRole:authorization.actor.role,requestedAuthVersion:authorization.actor.authVersion,operatingActorId:operating.id,operatingRole:operating.role,operatingAuthVersion:operating.authVersion};
  fingerprint=hash(canonical);const prior=await model(conn).findOne({tenantId:tenant._id,idempotencyKey:values.idempotencyKey}).session(session).lean();
  if(prior){if(prior.fingerprint!==fingerprint)throw fail('Funding reference was reused with different details',409);return {funding:prior,duplicate:true};}
  validatePair(source,destination,branch._id);
  if(BigInt(String(source.bookBalanceMinor))<amount)throw fail('The funding source has insufficient available funds',409);
  const [funding]=await model(conn).create([{...canonical,fingerprint}],{session});await audit(conn,session,authorization.actor,'treasury.funding.requested',funding);return {funding,duplicate:false};
 });}catch(error){
  if(error.code===11000){const prior=await model(conn).findOne({tenantId:tenant._id,requestedBy:actor.id,idempotencyKey:values.idempotencyKey}).lean();if(prior&&prior.fingerprint===fingerprint)return {funding:prior,duplicate:true};throw fail('Funding reference already exists with different details',409);}throw error;
 }
}
async function review(conn,tenant,actor,fundingId,input={}){
 if(!['approve','reject'].includes(input.decision))throw fail('Choose approve or reject');
 const note=text(input.note,'independent funding review',12,400),recordId=id(fundingId);await Promise.all([treasury.ensure(conn),ensureIndexes(conn)]);
 return transaction(conn,async session=>{
  const authorization=await treasury.access(conn,tenant,actor,{permission:'treasury.review',session,fence:true});
  const filter={_id:recordId,tenantId:authorization.tenant._id,...(authorization.actor.role==='Tenant Owner'?{}:{branchId:authorization.actor.branchId})};
  const initial=await model(conn).findOne(filter).session(session).lean();if(!initial)throw fail('Funding request not found',404);
  if(String(initial.requestedBy)===authorization.actor.id||String(initial.operatingActorId)===authorization.actor.id)throw fail('A different person must review the funding request and assigned account',403);
  if(initial.status!=='pending_review'){
   if(initial.status===(input.decision==='approve'?'posted':'rejected')&&String(initial.reviewedBy)===authorization.actor.id&&initial.reviewNote===note)return {funding:initial,duplicate:true};
   throw fail('Funding request has already been reviewed',409);
  }
  await pair(conn,session,authorization,initial);
  const locked=await model(conn).findOneAndUpdate({...filter,status:'pending_review'},{$inc:{revision:1}},{session,new:true}).lean();if(!locked)throw fail('Funding was reviewed concurrently',409);
  let posting=null;
  if(input.decision==='approve'){
   const maker={id:String(locked.requestedBy),role:locked.requestedRole,authVersion:locked.requestedAuthVersion,branchId:locked.branchId};
   const makerAuthorization=await treasury.access(conn,authorization.tenant,maker,{permission:'treasury.observe',session,fence:true});
   const {source,destination}=await pair(conn,session,makerAuthorization,locked);validatePair(source,destination,locked.branchId);
   const operating={id:String(locked.operatingActorId),role:locked.operatingRole,authVersion:locked.operatingAuthVersion,branchId:locked.branchId};
   const currentOperating=await treasury.access(conn,authorization.tenant,operating,{permission:'treasury.observe',session,fence:true});
   for(const account of [source,destination])if(account.moduleKey!=='shared'&&!hasModuleForUser(currentOperating.tenant,currentOperating.actor,account.moduleKey))throw fail('Underlying funding module access changed',403);
   posting=await treasury.applyMovements(conn,session,authorization,{sourceType:'treasury_funding',sourceRef:`FUND:${locked._id}`,branchId:String(locked.branchId),operatingActorId:String(locked.operatingActorId),
    legs:[{accountId:String(source._id),deltaMinor:String(-BigInt(String(locked.amountMinor)))},{accountId:String(destination._id),deltaMinor:String(locked.amountMinor)}],
    ledgerLines:[],description:`Funds transfer: ${source.name} to ${destination.name}`,evidenceReference:locked.evidenceReference});
  }
  const funding=await model(conn).findOneAndUpdate({...filter,status:'pending_review'},{$set:{status:input.decision==='approve'?'posted':'rejected',reviewedBy:authorization.actor.id,reviewedAt:new Date(),reviewNote:note,batchId:posting?.batch?._id||null,journalIds:posting?.journalIds||[]}},{session,new:true,runValidators:true}).lean();
  if(!funding)throw fail('Funding was reviewed concurrently',409);await audit(conn,session,authorization.actor,`treasury.funding.${funding.status}`,funding);return {funding,duplicate:false};
 });
}
async function list(conn,tenant,actor,input={}){
 await ensureIndexes(conn);const authorization=await treasury.access(conn,tenant,actor),filter={tenantId:authorization.tenant._id};
 Object.assign(filter,treasury.scope(authorization.actor));
 if(input.branchId){if(filter.branchId&&String(filter.branchId)!==id(input.branchId))throw fail('Cross-branch funding access denied',403);filter.branchId=id(input.branchId);}
 if(input.accountId){const accountId=id(input.accountId);await treasury.loadAccount(conn,authorization,accountId);filter.$or=[{sourceAccountId:accountId},{destinationAccountId:accountId}];}
 if(input.status){if(!['pending_review','posted','rejected'].includes(input.status))throw fail('Choose a valid funding status');filter.status=input.status;}
 if(!['Tenant Owner','Branch Manager','Reconciliation Officer','Auditor'].includes(authorization.actor.role))filter.operatingActorId=authorization.actor.id;
 const rows=await model(conn).find(filter).sort({createdAt:-1,_id:-1}).limit(100).lean(),visible=[],accounts=new Map();
 const load=accountId=>{const key=String(accountId);if(!accounts.has(key))accounts.set(key,treasury.loadAccount(conn,authorization,accountId).catch(error=>{if(error.status===404)return null;throw error;}));return accounts.get(key);};
 for(const funding of rows){const [source,destination]=await Promise.all([load(funding.sourceAccountId),load(funding.destinationAccountId)]);if(source&&destination)visible.push({...funding,source,destination});}
 return visible;
}
module.exports={request,review,list,validatePair,fail};
