#!/usr/bin/env node
'use strict';
// Authorization changes are committed after branch resolution but before the
// financial transaction. All records live in random loopback scratch databases.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const uri=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||uri.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(uri.hostname)||uri.host.includes(',')||uri.username||uri.password)
 throw Error('Manual authorization integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),scratch=`cfh_manual_auth_probe_${nonce}`,slug=`probe-manual-auth-${nonce}`;
uri.pathname='/'+scratch;process.env.MONGO_PLATFORM_URI=uri.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const models=require('../src/tenant/models'),Tenant=require('../src/platform/models/Tenant'),Usage=require('../src/platform/models/UsageCounter');
const commerce=require('../src/platform/services/commercial.service'),mobile=require('../src/tenant/services/mobileMoney.service'),cash=require('../src/tenant/services/cashDrawer.service');
const authorization=require('../src/tenant/services/financialAuthorization.service'),branchContext=require('../src/tenant/services/transactionBranch.service');
const {permissionsFor}=require('../src/config/roles');
let conn,tenant,operator,reviewer,first,second,shift,User,sequence=0;
const originalResolve=branchContext.resolveTransactionBranch,originalAuthorize=authorization.authorizeMobileRecording;
const input=(paymentMethod='Cash')=>({idempotencyKey:crypto.randomUUID(),customer:'Manual race customer',network:'MTN',networkReference:`MANUAL-${nonce}-${++sequence}`,
 currency:'UGX',amount:'1000',fee:'10',paymentMethod});
async function reset(){
 await User.updateOne({_id:operator.id},{$set:{status:'active',authVersion:0,role:'Mobile Money Operator',branchId:String(first._id),allowedModules:['mobile_money']}});
 await Tenant.updateOne({_id:tenant._id},{$set:{status:'active',enabledModules:['mobile_money'],'subscription.status':'granted','subscription.modules':['mobile_money'],
  'subscription.periodEnd':new Date(Date.now()+86400000),'subscription.limits.transactionsPerMonth':20}});
}
async function noEffect(label){
 assert.equal(await models.mobileTransactionModel(conn).countDocuments(),0,`${label}: no record`);
 assert.equal((await Usage.find({tenantId:tenant._id}).lean()).reduce((sum,row)=>sum+row.quantity,0),0,`${label}: no financial allowance used`);
 const drawer=await models.cashSessionModel(conn).findById(shift._id).lean();
 assert.equal(drawer.recordCount,0,`${label}: no drawer count`);assert.equal(String(drawer.provisionalMovementMinor),'0',`${label}: no drawer movement`);
 assert.equal(await models.auditEventModel(conn).countDocuments({action:'mobile_money.cash_in.recorded'}),0,`${label}: no successful record audit`);
}
async function race(label,commit,{paymentMethod='Cash',status=403}={}){
 await reset();
 const staleTenant=await Tenant.findById(tenant._id).lean(),staleActor={...operator,permissions:permissionsFor(operator.role),authVersion:0};let calls=0;
 branchContext.resolveTransactionBranch=async(...args)=>{
  const result=await originalResolve(...args);
  branchContext.resolveTransactionBranch=originalResolve;calls++;
  await commit();return result;
 };
 try{await assert.rejects(mobile.recordMobileMoney(conn,staleActor,input(paymentMethod),'cash_in',staleTenant),{status});}
 finally{branchContext.resolveTransactionBranch=originalResolve;}
 assert.equal(calls,1,`${label}: real administrative mutation occurs after initial branch resolution`);
 await noEffect(label);
}
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),Usage.createIndexes()]);conn=getTenantConnection(slug);await models.ensureTenantIndexes(conn);User=models.tenantUserModel(conn);
 const person=await User.create({name:'Manual integration operator',email:`op-${nonce}@example.invalid`,passwordHash:'unused-integration-password',role:'Mobile Money Operator',allowedModules:['mobile_money']});
 const supervisor=await User.create({name:'Manual integration reviewer',email:`review-${nonce}@example.invalid`,passwordHash:'unused-integration-password',role:'Reconciliation Officer',allowedModules:['mobile_money']});
 operator={id:String(person._id),role:person.role,authVersion:0,allowedModules:['mobile_money']};reviewer={id:String(supervisor._id),role:supervisor.role,allowedModules:['mobile_money']};
 first=await models.branchModel(conn).create({name:'Manual first',code:'first',currency:'UGX',createdBy:operator.id,updatedBy:operator.id});
 second=await models.branchModel(conn).create({name:'Manual second',code:'second',currency:'UGX',createdBy:operator.id,updatedBy:operator.id});
 operator.branchId=reviewer.branchId=String(first._id);await User.updateOne({_id:operator.id},{$set:{branchId:operator.branchId}});
 const snapshot=commerce.planSnapshot({...commerce.asPlanVersion(require('../src/data/store').plans.find(row=>row.code==='agent')),status:'published'});
 tenant=await Tenant.create({name:'Manual authorization probe',slug,dbName:conn.name,email:person.email,owner:'Integration',plan:'agent',status:'active',setupStatus:'complete',enabledModules:['mobile_money'],seatsReserved:2,branchCount:2,
  subscription:{...snapshot,modules:['mobile_money'],status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 shift=await cash.open(conn,tenant,operator,{openingCash:'0'});await cash.decideOpening(conn,tenant,reviewer,String(shift._id),{decision:'approve',note:'Independent physical opening verified for integration'});
 await race('operator disabled',()=>User.updateOne({_id:operator.id},{$set:{status:'disabled'},$inc:{authVersion:1}}));
 await race('credential version revoked',()=>User.updateOne({_id:operator.id},{$inc:{authVersion:1}}),{paymentMethod:'Wallet Balance'});
 await race('branch reassigned',()=>User.updateOne({_id:operator.id},{$set:{branchId:String(second._id)}}));
 await race('staff module removed',()=>User.updateOne({_id:operator.id},{$set:{allowedModules:[]}}),{paymentMethod:'Bank'});
 await race('stored role changed',()=>User.updateOne({_id:operator.id},{$set:{role:'Viewer'}}));
 await race('tenant module removed',()=>Tenant.updateOne({_id:tenant._id},{$set:{enabledModules:[]}}));
 await race('subscription revoked',()=>Tenant.updateOne({_id:tenant._id},{$set:{'subscription.status':'revoked'}}),{paymentMethod:'Wallet Balance'});
 await race('tenant suspended',()=>Tenant.updateOne({_id:tenant._id},{$set:{status:'suspended'}}),{paymentMethod:'Bank'});
 await race('quota reduced after request authentication',()=>Tenant.updateOne({_id:tenant._id},{$set:{'subscription.limits.transactionsPerMonth':0}}),{status:429});
 await reset();
 // The reverse ordering is also important: once the transaction fences the
 // account, a concurrent revocation waits for its commit instead of overtaking it.
 let revoked,revocationFinished=false;
 authorization.authorizeMobileRecording=async(...args)=>{
  authorization.authorizeMobileRecording=originalAuthorize;
  const result=await originalAuthorize(...args);
  revoked=User.updateOne({_id:operator.id},{$set:{status:'disabled'},$inc:{authVersion:1}}).then(value=>{revocationFinished=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,35));
  assert.equal(revocationFinished,false,'concurrent revocation waits for the in-flight financial transaction');
  return result;
 };
 const recorded=await mobile.recordMobileMoney(conn,operator,input(),'cash_in',await Tenant.findById(tenant._id).lean());
 await revoked;assert.equal(revocationFinished,true);assert.equal(recorded.duplicate,false);
 assert.equal(await models.mobileTransactionModel(conn).countDocuments(),1);
 const counted=await models.cashSessionModel(conn).findById(shift._id).lean();assert.equal(counted.recordCount,1);assert.equal(String(counted.provisionalMovementMinor),'1000');
 assert.equal((await Usage.find({tenantId:tenant._id}).lean()).reduce((sum,row)=>sum+row.quantity,0),1);
 console.log('PASS: committed manual account disable, credential revoke, branch/role reassignment, staff/tenant module removal, subscription revoke, suspension and quota reduction block Cash/Bank/Wallet records without cash/quota/audit effects; concurrent revoke is serialized after an already-authorized financial commit.');
}
async function cleanup(){
 branchContext.resolveTransactionBranch=originalResolve;authorization.authorizeMobileRecording=originalAuthorize;
 if(mongoose.connection.readyState===1&&mongoose.connection.name===scratch&&/^cfh_manual_auth_probe_[a-f0-9]{16}$/.test(scratch)){
  if(conn)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();
 }await mongoose.disconnect();
}
main().catch(error=>{console.error('MANUAL AUTHORIZATION INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Manual authorization scratch cleanup failed:',error.message);process.exitCode=1;}));
