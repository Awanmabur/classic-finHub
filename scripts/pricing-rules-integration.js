#!/usr/bin/env node
'use strict';
// Actual pricing configuration writes use random disposable loopback databases.
// No external provider, outbound email or production database is contacted.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||process.env.PLATFORM_DB_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Pricing configuration integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),database='cfh_pricing_rules_'+nonce,slugs=['pricing-a-'+nonce,'pricing-b-'+nonce];
configured.pathname='/'+database;
Object.assign(process.env,{NODE_ENV:'test',MFA_ENABLED:'false',MONGO_PLATFORM_URI:configured.toString(),PLATFORM_DB_URI:'',MONGO_URI_BASE:'',TRANSFER_SMS_PROVIDER:'none',TENANT_BACKUPS_ENABLED:'false'});
const mongoose=require('mongoose'),mongo=require('../src/config/mongo'),core=require('../src/tenant/models');
const Tenant=require('../src/platform/models/Tenant'),pricing=require('../src/tenant/pricing/service'),store=require('../src/tenant/pricing/models'),commerce=require('../src/platform/services/commercial.service');
let connections=[];
async function main(){
 await mongo.connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Tenant.createIndexes();connections=slugs.map(mongo.getTenantConnection);await Promise.all(connections.map(core.ensureTenantIndexes));
 const terms=commerce.planSnapshot({...commerce.asPlanVersion(require('../src/data/store').plans.find(row=>row.code==='enterprise')),status:'published'}),tenants=[],owners=[];
 for(let index=0;index<connections.length;index++){
  const conn=connections[index],tenant=await Tenant.create({name:'Pricing Rules '+index,slug:slugs[index],dbName:conn.name,owner:'Pricing Owner',email:'pricing-'+index+'-'+nonce+'@example.invalid',plan:terms.planCode,status:'active',setupStatus:'complete',enabledModules:terms.modules,seatsReserved:2,branchCount:2,
   subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
  const owner=await core.tenantUserModel(conn).create({name:'Pricing Owner',email:tenant.email,role:'Tenant Owner',passwordHash:'unused-in-direct-service-fixture',status:'active',authVersion:0,allowedModules:terms.modules});
  tenants.push(tenant.toObject());owners.push({id:String(owner._id),role:'Tenant Owner',permissions:['*'],authVersion:0});
 }
 const [conn,other]=connections,[tenant,otherTenant]=tenants,[owner,otherOwner]=owners,Branch=core.branchModel(conn),User=core.tenantUserModel(conn);
 const main=await Branch.create({name:'Main office',code:'main',currency:'SSP',currencies:['SSP','USD','UGX'],createdBy:owner.id,updatedBy:owner.id});
 const second=await Branch.create({name:'Second office',code:'second',currency:'USD',currencies:['USD'],createdBy:owner.id,updatedBy:owner.id});
 const input={branchId:'',operation:'mobile_money.cash_in',currency:'SSP',network:'',feeFixed:'1.25',feePercent:'1.25',costFixed:'0.10',costPercent:'0.50',enabled:'true',revision:'0'};
 const base=await pricing.save(conn,tenant,owner,input);assert.equal(base.revision,0);assert.equal(base.fixedFeeMinor,'125');assert.equal(base.feeBps,125);assert.equal(base.fixedCostMinor,'10');
 const createdAudit=await core.auditEventModel(conn).findOne({action:'workspace.pricing.created',targetId:base._id}).lean();
 assert.equal(createdAudit.metadata.before,null);assert.deepEqual(createdAudit.metadata.after,{fixedFeeMinor:'125',feeBps:125,fixedCostMinor:'10',costBps:50,enabled:true,revision:0});
 const read=await pricing.read(conn,tenant,owner);assert(read.operations.some(row=>row.key==='money_transfer.send'));assert.equal(read.rules.length,1);assert.equal(read.branches.length,2);
 assert.deepEqual(pricing.snapshot(base.toObject(),'10000','SSP'),{policyId:String(base._id),revision:0,operation:input.operation,currency:'SSP',feeMinor:'250',costMinor:'60',fixedFeeMinor:'125',feeBps:125,fixedCostMinor:'10',costBps:50});
 await assert.rejects(pricing.save(conn,tenant,owner,input),{status:409},'the real unique index rejects a duplicate scope');
 const network=await pricing.save(conn,tenant,owner,{...input,network:'MTN SSD',feeFixed:'2.00'});
 const branch=await pricing.save(conn,tenant,owner,{...input,branchId:String(main._id),feeFixed:'3.00'});
 let context=await pricing.context(conn,tenant,main);assert.equal(String(pricing.select(context,{operation:input.operation,currency:'SSP',network:'MTN SSD',branchId:main._id})._id),String(branch._id));
 const disabled=await pricing.save(conn,tenant,owner,{...input,id:String(branch._id),branchId:String(main._id),enabled:'false',feeFixed:'3.00',feePercent:'2.50',costFixed:'0.20',costPercent:'1.50',revision:'0'});assert.equal(disabled.revision,1);
 const changedAudit=await core.auditEventModel(conn).findOne({action:'workspace.pricing.updated',targetId:branch._id,'metadata.revision':1}).lean();
 assert.deepEqual(changedAudit.metadata.before,{fixedFeeMinor:'300',feeBps:125,fixedCostMinor:'10',costBps:50,enabled:true,revision:0});
 assert.deepEqual(changedAudit.metadata.after,{fixedFeeMinor:'300',feeBps:250,fixedCostMinor:'20',costBps:150,enabled:false,revision:1});
 assert.equal(changedAudit.metadata.branchId,String(main._id));assert.equal(changedAudit.metadata.operation,input.operation);
 context=await pricing.context(conn,tenant,main);assert.equal(String(pricing.select(context,{operation:input.operation,currency:'SSP',network:'MTN SSD',branchId:main._id})._id),String(network._id));
 await assert.rejects(pricing.save(conn,tenant,owner,{...input,id:String(branch._id),branchId:String(main._id),revision:'0'}),{status:409},'an optimistic revision prevents stale settings overwrite');
 await assert.rejects(pricing.save(conn,tenant,owner,{...input,id:String(branch._id),branchId:String(main._id),operation:'mobile_money.cash_out',revision:'1'}),{status:409},'existing scope identity cannot change');
 await assert.rejects(pricing.save(conn,tenant,owner,{...input,branchId:String(second._id)}),{status:409},'branch currencies remain authoritative');
 await assert.rejects(pricing.save(conn,tenant,owner,{...input,branchId:String(new mongoose.Types.ObjectId())}),{status:409});
 await assert.rejects(pricing.read(other,tenant,owner),{status:403},'tenant context cannot select another physical database');
 await assert.rejects(pricing.save(other,otherTenant,otherOwner,{...input,id:String(base._id)}),{status:409},'a foreign rule identifier cannot cross tenant databases');
 await assert.rejects(pricing.save(conn,tenant,owner,{...input,tenantId:String(otherTenant._id)}),{status:400},'routing fields cannot be injected');
 await Branch.updateOne({_id:main._id},{$set:{status:'archived'}});
 const inactive=await pricing.save(conn,tenant,owner,{...input,id:String(branch._id),branchId:String(main._id),enabled:'false',revision:'1'});assert.equal(inactive.revision,2,'an owner can disable an inactive branch rule');
 await assert.rejects(pricing.save(conn,tenant,owner,{...input,id:String(branch._id),branchId:String(main._id),enabled:'true',revision:'2'}),{status:409});
 await Branch.updateOne({_id:main._id},{$set:{status:'active'}});
 const Audit=core.auditEventModel(conn),original=Audit.create,before=await store.model(conn).findById(base._id).lean(),tenantBefore=await Tenant.findById(tenant._id).lean(),auditsBefore=await Audit.countDocuments();
 Audit.create=async()=>{throw Error('Synthetic pricing audit failure');};
 try{await assert.rejects(pricing.save(conn,tenant,owner,{...input,id:String(base._id),feeFixed:'8.00',revision:'0'}),/Synthetic pricing audit failure/);}finally{Audit.create=original;}
 const after=await store.model(conn).findById(base._id).lean();assert.equal(after.fixedFeeMinor,before.fixedFeeMinor);assert.equal(after.revision,before.revision);assert.equal((await Tenant.findById(tenant._id).lean()).__v,tenantBefore.__v,'tenant authorization fence rolls back with the audit');
 assert.equal(await Audit.countDocuments(),auditsBefore,'failed audit cannot leave a price-change event behind');
 const person=await User.findById(owner.id).lean();
 await User.updateOne({_id:owner.id},{$set:{role:'Viewer'}});await assert.rejects(pricing.read(conn,tenant,owner),{status:403});await assert.rejects(pricing.save(conn,tenant,owner,input),{status:403});
 await User.updateOne({_id:owner.id},{$set:{role:'Tenant Owner',authVersion:1}});await assert.rejects(pricing.read(conn,tenant,owner),{status:403});await assert.rejects(pricing.save(conn,tenant,owner,input),{status:403});
 await User.updateOne({_id:owner.id},{$set:{authVersion:0,status:'disabled'}});await assert.rejects(pricing.read(conn,tenant,owner),{status:403});
 await User.updateOne({_id:owner.id},{$set:{status:'active'}});process.env.MFA_ENABLED='true';await assert.rejects(pricing.read(conn,tenant,owner),{status:403});await User.updateOne({_id:owner.id},{$set:{mfaEnabledAt:new Date()}});assert((await pricing.read(conn,tenant,owner)).rules.length>0);process.env.MFA_ENABLED='false';
 await Tenant.updateOne({_id:tenant._id},{$pull:{enabledModules:'mobile_money'}});const restricted=await pricing.read(conn,tenant,owner);assert(!restricted.operations.some(row=>row.moduleKey==='mobile_money'));assert.equal(restricted.rules.length,0);await assert.rejects(pricing.save(conn,tenant,owner,input),{status:403},'module prices cannot be configured after entitlement revocation');
 await User.updateOne({_id:owner.id},{$set:{authVersion:person.authVersion}});
 assert(await Audit.exists({action:'workspace.pricing.created','metadata.costEstimateOnly':true}));
 console.log('PASS: real pricing rules, exact charges/separate cost estimates, unique scopes, branch/network fallback, disabled/inactive rules, optimistic revisions, immutable scope, audit rollback, fresh owner/credential/MFA/entitlement enforcement and tenant database isolation (disposable loopback only).');
}
main().catch(error=>{console.error('Pricing configuration integration failed:',error.stack);process.exitCode=1;}).finally(async()=>{
 if(mongoose.connection.readyState===1&&mongoose.connection.name===database&&/^cfh_pricing_rules_[a-f0-9]{16}$/.test(database)){
  for(let index=0;index<connections.length;index++){const conn=connections[index];if(conn.name===mongo.tenantDbNameFromSlug(slugs[index]))await conn.db.dropDatabase();}
  await mongoose.connection.db.dropDatabase();
 }
 await mongoose.disconnect();
});
