#!/usr/bin/env node
'use strict';
// Committed authorization changes are interleaved immediately before financial
// transactions in unique loopback scratch databases. Never shared tenant data.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const uri=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||uri.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(uri.hostname)||uri.host.includes(',')||uri.username||uri.password)
 throw Error('Operational authorization checks require one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),scratch=`cfh_operation_auth_probe_${nonce}`,slug=`probe-operation-auth-${nonce}`;
uri.pathname='/'+scratch;process.env.MONGO_PLATFORM_URI=uri.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose'),{connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const models=require('../src/tenant/models'),Tenant=require('../src/platform/models/Tenant'),Usage=require('../src/platform/models/UsageCounter');
const commerce=require('../src/platform/services/commercial.service'),{permissionsFor}=require('../src/config/roles');
const transfer=require('../src/tenant/services/moneyTransfer.service'),banking=require('../src/tenant/services/banking.service'),forex=require('../src/tenant/services/forex.service');
const modules=['money_transfer','banking','forex'],roles=['Money Transfer Operator','Banking Operator','Forex Operator'];
let conn,User,tenant,first,second,originalStartSession,passed=0;const makers=[],reviewers=[];
const note='Independent supporting evidence checked for authorization integration';
async function counters(){
 const names=['transferContactModel','transferOrderModel','bankReferenceModel','bankingRequestModel','forexRateModel','forexQuoteModel','auditEventModel'];
 const counts=await Promise.all(names.map(name=>models[name](conn).countDocuments()));
 return {counts,usage:(await Usage.find({tenantId:tenant._id}).lean()).reduce((sum,row)=>sum+row.quantity,0)};
}
async function reset(actor){
 await User.updateOne({_id:actor.id},{$set:{status:'active',role:actor.role,branchId:String(first._id),allowedModules:[actor.module],authVersion:0}});
 await Tenant.updateOne({_id:tenant._id},{$set:{status:'active',enabledModules:modules,'subscription.status':'granted','subscription.modules':modules,
  'subscription.periodEnd':new Date(Date.now()+86400000),'subscription.limits.transactionsPerMonth':100}});
}
async function denied(label,actor,commit,run,status=403){
 await reset(actor);const current=await Tenant.findById(tenant._id).lean(),before=await counters();let calls=0;
 conn.startSession=async(...args)=>{
  const session=await originalStartSession(...args);conn.startSession=originalStartSession;calls++;
  await commit();return session;
 };
 try{await assert.rejects(run(current,{...actor}),{status},label);}
 finally{conn.startSession=originalStartSession;}
 assert.equal(calls,1,`${label}: administrative change interleaves after request validation and before transaction`);
 assert.deepEqual(await counters(),before,`${label}: records, directories, audits and quota unchanged`);passed++;
}
const disable=actor=>()=>User.updateOne({_id:actor.id},{$set:{status:'disabled'},$inc:{authVersion:1}});
const reassign=actor=>()=>User.updateOne({_id:actor.id},{$set:{branchId:String(second._id)}});
const removeAssignment=actor=>()=>User.updateOne({_id:actor.id},{$set:{allowedModules:[]}});
const changeRole=actor=>()=>User.updateOne({_id:actor.id},{$set:{role:'Viewer'}});
const revokeModule=actor=>()=>Tenant.updateOne({_id:tenant._id},{$pull:{enabledModules:actor.module}});
const lowerQuota=()=>Tenant.updateOne({_id:tenant._id},{$set:{'subscription.limits.transactionsPerMonth':0}});
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),Usage.createIndexes()]);conn=getTenantConnection(slug);await models.ensureTenantIndexes(conn);User=models.tenantUserModel(conn);originalStartSession=conn.startSession.bind(conn);
 const actorId=String(new mongoose.Types.ObjectId());
 first=await models.branchModel(conn).create({name:'Operations first',code:'first',currency:'UGX',createdBy:actorId,updatedBy:actorId});
 second=await models.branchModel(conn).create({name:'Operations second',code:'second',currency:'UGX',createdBy:actorId,updatedBy:actorId});
 const snapshot=commerce.planSnapshot({...commerce.asPlanVersion(require('../src/data/store').plans.find(row=>row.code==='enterprise')),status:'published'});
 tenant=await Tenant.create({name:'Operational auth probe',slug,dbName:conn.name,email:`owner-${nonce}@example.invalid`,owner:'Probe',plan:'enterprise',status:'active',setupStatus:'complete',enabledModules:modules,seatsReserved:7,branchCount:2,
  subscription:{...snapshot,modules,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 for(let i=0;i<modules.length;i++)for(const review of [false,true]){
  const person=await User.create({name:'Persisted operational account',email:`${review?'review':'maker'}-${i}-${nonce}@example.invalid`,passwordHash:'unused-integration-password',
   role:review?'Reconciliation Officer':roles[i],branchId:String(first._id),allowedModules:[modules[i]],authVersion:0});
  (review?reviewers:makers).push({id:String(person._id),role:person.role,module:modules[i],authVersion:0,branchId:String(first._id),allowedModules:[modules[i]],permissions:permissionsFor(person.role)});
 }
 const sender=await transfer.addContact(conn,tenant,makers[0],{kind:'sender',fullName:'Sender probe',phone:'+256700123456',country:'UG'});
 const receiver=await transfer.addContact(conn,tenant,makers[0],{kind:'beneficiary',fullName:'Receiver probe',phone:'+256701234567',country:'UG'});
 const source=await banking.createReference(conn,tenant,makers[1],{customerName:'Bank probe',institutionName:'Scratch bank',last4:'1234',currency:'UGX'});
 const destination=await banking.createReference(conn,tenant,makers[1],{customerName:'Destination probe',institutionName:'Scratch bank',last4:'5678',currency:'UGX'});
 const rateInput={fromCurrency:'UGX',toCurrency:'USD',rateDecimal:'0.000275',validHours:24,note};
 const rate=await forex.proposeRate(conn,tenant,makers[2],rateInput);await forex.decideRate(conn,tenant,reviewers[2],String(rate._id),{decision:'approve',note});
 const pendingRate=await forex.proposeRate(conn,tenant,makers[2],{...rateInput,rateDecimal:'0.000280'});
 const transferInput=()=>({senderId:String(sender._id),beneficiaryId:String(receiver._id),currency:'UGX',amount:'20000',fee:'100',validDays:7,idempotencyKey:crypto.randomUUID()});
 const bankInput=()=>({kind:'transfer_request',sourceId:String(source._id),destinationId:String(destination._id),currency:'UGX',amount:'20000',validDays:7,note,idempotencyKey:crypto.randomUUID()});
 const quoteInput=()=>({rateId:String(rate._id),customerLabel:'Quote probe',amount:'20000',validMinutes:15,note,idempotencyKey:crypto.randomUUID(),operation:'buy'});
 const transferRecord=(await transfer.createRequest(conn,tenant,makers[0],transferInput())).order;
 const bankRecord=(await banking.createRequest(conn,tenant,makers[1],bankInput())).order;
 const quoteRecord=(await forex.createQuote(conn,tenant,makers[2],quoteInput())).quote;
 const specs=[
  {module:modules[0],create:(t,a)=>transfer.createRequest(conn,t,a,transferInput()),review:(t,a)=>transfer.decide(conn,t,a,String(transferRecord._id),{decision:'approve',note}),cancel:(t,a)=>transfer.cancel(conn,t,a,String(transferRecord._id),{note})},
  {module:modules[1],create:(t,a)=>banking.createRequest(conn,t,a,bankInput()),review:(t,a)=>banking.decide(conn,t,a,String(bankRecord._id),{decision:'approve',note}),cancel:(t,a)=>banking.cancel(conn,t,a,String(bankRecord._id),{note})},
  {module:modules[2],create:(t,a)=>forex.createQuote(conn,t,a,quoteInput()),review:(t,a)=>forex.decideQuote(conn,t,a,String(quoteRecord._id),{decision:'approve',note}),cancel:(t,a)=>forex.cancelQuote(conn,t,a,String(quoteRecord._id),{note})}
 ];
 for(let i=0;i<specs.length;i++){
  const spec=specs[i],maker=makers[i],reviewer=reviewers[i];
  for(const [reason,commit,status=403] of [['disabled account',disable(maker)],['branch reassigned',reassign(maker)],['module unassigned',removeAssignment(maker)],['role changed',changeRole(maker)],['tenant module revoked',revokeModule(maker)],['quota reduced',lowerQuota,429]])
   await denied(`${spec.module} creation: ${reason}`,maker,commit,spec.create,status);
  await reset(maker);
  await denied(`${spec.module} independent review: disabled reviewer`,reviewer,disable(reviewer),spec.review);
  await denied(`${spec.module} independent review: reassigned reviewer`,reviewer,reassign(reviewer),spec.review);
  await denied(`${spec.module} cancellation: disabled originator`,maker,disable(maker),spec.cancel);
 }
 const transferContact={kind:'sender',fullName:'Updated probe sender',phone:'+256700123456',country:'UG'};
 await denied('Transfer contact creation',makers[0],disable(makers[0]),(t,a)=>transfer.addContact(conn,t,a,transferContact));
 await denied('Transfer contact update',makers[0],reassign(makers[0]),(t,a)=>transfer.updateContact(conn,t,a,String(sender._id),transferContact));
 await denied('Transfer contact archive',makers[0],revokeModule(makers[0]),(t,a)=>transfer.archiveContact(conn,t,a,String(sender._id)));
 const bankReference={customerName:'Updated bank customer',institutionName:'Scratch bank',last4:'1234',currency:'UGX'};
 await denied('Bank reference creation',makers[1],disable(makers[1]),(t,a)=>banking.createReference(conn,t,a,bankReference));
 await denied('Bank reference update',makers[1],reassign(makers[1]),(t,a)=>banking.updateReference(conn,t,a,String(source._id),bankReference));
 await denied('Bank reference archive',makers[1],revokeModule(makers[1]),(t,a)=>banking.archiveReference(conn,t,a,String(source._id)));
 await denied('Forex rate proposal',makers[2],disable(makers[2]),(t,a)=>forex.proposeRate(conn,t,a,rateInput));
 await denied('Forex rate review',reviewers[2],removeAssignment(reviewers[2]),(t,a)=>forex.decideRate(conn,t,a,String(pendingRate._id),{decision:'approve',note}));
 // Denied races leave the original independent-review paths available.
 for(let i=0;i<specs.length;i++){await reset(reviewers[i]);const result=await specs[i].review(await Tenant.findById(tenant._id).lean(),reviewers[i]);assert.match(result.status,/^approved_pending_/);}
 console.log(`PASS: ${passed} committed authorization races block transfer/banking/forex creation, review, cancellation, contacts, bank references and FX rates without record/audit/quota side effects; independent authorized review remains available.`);
}
async function cleanup(){
 if(conn&&originalStartSession)conn.startSession=originalStartSession;
 if(mongoose.connection.readyState===1&&mongoose.connection.name===scratch&&/^cfh_operation_auth_probe_[a-f0-9]{16}$/.test(scratch)){
  if(conn)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();
 }await mongoose.disconnect();
}
main().catch(error=>{console.error('OPERATION AUTHORIZATION INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Operational authorization scratch cleanup failed:',error.message);process.exitCode=1;}));
