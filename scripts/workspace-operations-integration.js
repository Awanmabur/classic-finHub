#!/usr/bin/env node
'use strict';
// Only randomly named scratch databases on a local replica set are touched.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Workspace operations integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),platformName=`cfh_workspace_ops_${nonce}`,slug=`workspace-ops-${nonce}`;
configured.pathname='/'+platformName;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose'),core=require('../src/tenant/models'),Tenant=require('../src/platform/models/Tenant');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const commerce=require('../src/platform/services/commercial.service'),{permissionsFor}=require('../src/config/roles');
const workspace=require('../src/tenant/workspace/service'),treasury=require('../src/tenant/treasury/service'),funds=require('../src/tenant/treasury/models'),cash=require('../src/tenant/services/cashDrawer.service');
const oid=()=>String(new mongoose.Types.ObjectId());
let conn;
const owner={id:oid(),role:'Tenant Owner',permissions:['*'],authVersion:0},teller={id:oid(),role:'Money Transfer Operator',permissions:permissionsFor('Money Transfer Operator'),allowedModules:['money_transfer'],authVersion:0};
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Tenant.createIndexes();conn=getTenantConnection(slug);await core.ensureTenantIndexes(conn);await funds.ensure(conn);
 const modules=['money_transfer'],terms=commerce.planSnapshot({...commerce.asPlanVersion({...require('../src/data/store').plans.find(plan=>plan.code==='enterprise'),code:'workspace_operations_probe',modules}),status:'published'});
 const tenant=await Tenant.create({name:'Workspace operation proof',slug,dbName:conn.name,owner:'Owner',email:`${nonce}@example.invalid`,plan:terms.planCode,status:'active',setupStatus:'complete',enabledModules:modules,seatsReserved:3,branchCount:0,subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const User=core.tenantUserModel(conn);
 await User.create({_id:owner.id,name:'Workspace Owner',email:`owner-${nonce}@example.invalid`,passwordHash:'isolated-test-only',role:owner.role,allowedModules:modules,mfaEnabledAt:new Date(),authVersion:0});
 let report=await workspace.overview(conn,tenant,owner);assert.equal(report.state,'blocked');assert.equal(report.branches,0);assert.equal(report.funds.ready,0);assert.equal(report.waiting,0);
 const main=await core.branchModel(conn).create({code:'main',name:'Main',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
 owner.branchId=teller.branchId=String(main._id);owner.viewBranchId=String(main._id);
 await User.updateOne({_id:owner.id},{$set:{branchId:main._id}});
 await User.create({_id:teller.id,name:'Transfer Teller',email:`teller-${nonce}@example.invalid`,passwordHash:'isolated-test-only',role:teller.role,branchId:main._id,allowedModules:modules,authVersion:0});
 report=await workspace.overview(conn,tenant,owner);assert.equal(report.state,'blocked');assert.equal(report.modules[0].operators,1);assert.equal(report.modules[0].preparedOperators,0);
 async function open(kind,code,assigned=null){
  const account=await treasury.createAccount(conn,tenant,owner,{kind,code,name:'Recorded '+code,currency:'UGX',operatorId:assigned,isDefault:true});
  const response=await treasury.requestObservation(conn,tenant,teller,account._id,{kind:'opening',actualBalance:kind==='transfer_clearing'?'0':'1000',observedAt:new Date(Date.now()-1000).toISOString(),evidenceType:kind==='cash'?'cash_count':kind==='transfer_clearing'?'transfer_register':'bank_statement',evidenceReference:'WORKSPACE-OPEN-'+code,note:'Actual count or statement inspected before recording opening balance',idempotencyKey:crypto.randomUUID()});
  return {account,observation:response.observation};
 }
 const drawer=await open('cash','TELLER_CASH',teller.id),clearing=await open('transfer_clearing','TRANSFER_PAYABLE');
 report=await workspace.overview(conn,tenant,owner);assert.equal(report.queues.find(row=>row.id==='opening').count,2);assert.equal(report.funds.unknown,2);assert.equal(report.state,'blocked');
 for(const entry of [drawer,clearing])await treasury.reviewObservation(conn,tenant,owner,entry.observation._id,{decision:'approve',note:'Independent reviewer inspected the actual opening evidence'});
 report=await workspace.overview(conn,tenant,owner);assert.equal(report.funds.ready,2);assert.equal(report.modules[0].preparedOperators,0,'reviewed cash is not an open verified cash shift');
 const shift=await cash.open(conn,tenant,teller,{openingCash:'1000'});
 report=await workspace.overview(conn,tenant,owner);assert.equal(report.queues.find(row=>row.id==='shift-opening').count,1);assert.equal(report.cash.verified,0);
 await cash.decideOpening(conn,tenant,owner,shift._id,{decision:'approve',note:'Actual opening cash physically counted by an independent supervisor'});
 report=await workspace.overview(conn,tenant,owner);assert.equal(report.state,'ready');assert.equal(report.modules[0].preparedOperators,1);assert.equal(report.cash.verified,1);assert.equal(report.waiting,0);assert.equal(report.sms,null);assert(!report.queues.some(row=>row.id==='momo'||row.id==='expenses'),'unlicensed operations do not leak counts or actions');
 const bank=await open('bank','SETTLEMENT_BANK');report=await workspace.overview(conn,tenant,owner);assert.equal(report.state,'attention');assert.equal(report.queues.find(row=>row.id==='opening').count,1);assert.equal(report.funds.unknown,1);assert.equal(report.next.href,'/tenant/treasury');
 await treasury.reviewObservation(conn,tenant,owner,bank.observation._id,{decision:'approve',note:'Independent current bank statement agrees with its registered opening'});assert.equal((await workspace.overview(conn,tenant,owner)).state,'ready');
 await core.branchModel(conn).create({code:'east',name:'East not configured',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
 const all=await workspace.overview(conn,tenant,{...owner,viewBranchId:'all'});assert.equal(all.state,'blocked');assert.equal(all.modules.length,2);assert(all.modules.some(row=>row.branch==='East not configured'&&row.state==='blocked'));assert.equal((await workspace.overview(conn,tenant,owner)).state,'ready');assert.equal(String((await User.findById(teller.id)).branchId),String(main._id),'read view never changes transaction assignments');
 await User.updateOne({_id:teller.id},{$set:{allowedModules:[]}});assert.equal((await workspace.overview(conn,tenant,owner)).state,'blocked','fresh stored operator assignment overrides stale caller data');await User.updateOne({_id:teller.id},{$set:{allowedModules:modules}});
 await User.updateOne({_id:owner.id},{$set:{authVersion:1}});
 const trusted=await workspace.access(conn,tenant,{...owner,allowedModules:['forged'],authVersion:0});assert.deepEqual(trusted.actor.allowedModules,modules);assert.equal(trusted.actor.authVersion,1);assert.equal(trusted.actor.viewBranchId,String(main._id));
 const profile=workspace.defaults(tenant).profile;await assert.rejects(workspace.save(conn,tenant,owner,'profile',{...profile,revision:0}),{status:403},'a stale credential version cannot authorize a workspace write');
 await Tenant.updateOne({_id:tenant._id},{$set:{enabledModules:[]}});report=await workspace.overview(conn,tenant,owner);assert.equal(report.modules.length,0);assert.equal(report.queues.length,0);assert.equal(report.state,'blocked','fresh entitlements override a stale tenant object');
 await User.updateOne({_id:owner.id},{$set:{role:'Viewer'}});await assert.rejects(workspace.overview(conn,tenant,owner),{status:403},'fresh stored roles defeat forged owner/read-view metadata');
 console.log('PASS: Workspace operational readiness moves from fresh blocked setup to reviewed funds and own verified shift, scoped Main/All, real pending opening queues, module isolation, fresh operator/tenant revocation, and credential-fenced settings writes.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_workspace_ops_[a-f0-9]{16}$/.test(platformName)){if(conn?.name===require('../src/config/tenantDatabaseName').tenantDbNameFromSlug(slug))await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('WORKSPACE OPERATIONS INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Workspace operations scratch cleanup failed:',error.message);process.exitCode=1;}));
