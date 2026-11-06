#!/usr/bin/env node
'use strict';
// Random scratch databases on one loopback replica set; never shared data.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Mobile workspace integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),scratchName=`cfh_mobile_workspace_probe_${nonce}`,slugs=[`probe-mobile-workspace-a-${nonce}`,`probe-mobile-workspace-b-${nonce}`];
configured.pathname='/'+scratchName;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const models=require('../src/tenant/models'),mobile=require('../src/tenant/services/mobileMoney.service'),workspace=require('../src/tenant/services/mobileMoneyWorkspace.service'),cash=require('../src/tenant/services/cashDrawer.service');
const Tenant=require('../src/platform/models/Tenant'),commercial=require('../src/platform/services/commercial.service'),{permissionsFor}=require('../src/config/roles');
let connections=[];
const id=()=>String(new mongoose.Types.ObjectId());
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),require('../src/platform/models/UsageCounter').createIndexes()]);
 connections=slugs.map(getTenantConnection);await Promise.all(connections.map(models.ensureTenantIndexes));
 const [conn,other]=connections,operator={id:id(),role:'Mobile Money Operator',permissions:permissionsFor('Mobile Money Operator'),allowedModules:['mobile_money']};
 const reviewer={id:id(),role:'Reconciliation Officer',permissions:permissionsFor('Reconciliation Officer'),allowedModules:['mobile_money']};
 const branch=await models.branchModel(conn).create({name:'KES operations',code:'kes-ops',currency:'KES',createdBy:operator.id,updatedBy:operator.id});
 const second=await models.branchModel(conn).create({name:'UGX operations',code:'ugx-ops',currency:'UGX',createdBy:operator.id,updatedBy:operator.id});
 operator.branchId=reviewer.branchId=String(branch._id);
    await require('../src/tenant/models').tenantUserModel(conn).create({_id:operator.id,name:'Persisted integration operator',email:`operator-${nonce}@example.invalid`,passwordHash:'unused-integration-password',role:operator.role,branchId:operator.branchId,allowedModules:['mobile_money'],status:'active',authVersion:0});
 const snapshot=commercial.planSnapshot({...commercial.asPlanVersion(require('../src/data/store').plans.find(p=>p.code==='agent')),status:'published'});
 const tenant=await Tenant.create({name:'Workspace integration',slug:slugs[0],dbName:conn.name,owner:'Probe',email:`${nonce}@example.invalid`,plan:'agent',status:'active',setupStatus:'complete',enabledModules:snapshot.modules,seatsReserved:3,branchCount:2,
  subscription:{...snapshot,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const shift=await cash.open(conn,tenant,operator,{openingCash:'1000.00'});await cash.decideOpening(conn,tenant,reviewer,String(shift._id),{decision:'approve',note:'Independent opening count verified for integration'});
 let sequence=0;
 const input=(amount,fee='0',extra={})=>({customer:'Workspace customer',customerPhone:'+254 (700) 123-456',customerNote:'=HYPERLINK("example.invalid")',network:'MTN',networkReference:`WORK-${nonce}-${++sequence}`,currency:'KES',amount,fee,idempotencyKey:crypto.randomUUID(),...extra});
 const recorded=[];
 for(const [operation,amount,fee,extra] of [['cash_in','10.25','0.25',{}],['cash_out','2.10','0.10',{}],['cash_in','300.45','1.00',{paymentMethod:'Bank',network:'Africell'}],['cash_in','4.00','0',{paymentMethod:'Wallet Balance',network:'M-Pesa'}]]){
  const body=input(amount,fee,extra),result=await mobile.recordMobileMoney(conn,operator,body,operation,tenant);recorded.push(result.created);
  assert.equal((await mobile.recordMobileMoney(conn,operator,body,operation,tenant)).duplicate,true);
  await assert.rejects(mobile.recordMobileMoney(conn,operator,{...body,customerNote:'Changed immutable evidence'},operation,tenant),{status:409});
 }
 assert(recorded[0].cashSessionId);assert.equal(recorded[2].cashSessionId,null);assert.equal(recorded[3].cashSessionId,null);
 assert.equal(String((await models.cashSessionModel(conn).findById(shift._id)).provisionalMovementMinor),'815','bank/wallet records do not enter physical drawer');
 const voided=(await mobile.recordMobileMoney(conn,operator,input('1.00'),'cash_out',tenant)).created;
 await mobile.requestVoid(conn,operator,String(voided._id),'Incorrect source amount needs independent correction');
 await mobile.decideVoid(conn,reviewer,String(voided._id),'approve','Receipt confirms the recorded amount was incorrect');
 const today=new Date().toISOString().slice(0,10),yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
 const fixture=(extra={})=>({idempotencyKey:crypto.randomUUID(),operation:'cash_in',customer:'Fixture receipt',network:'MTN',networkReference:`FIX-${nonce}-${++sequence}`,currency:'KES',amountMinor:'735',feeMinor:'5',operatorId:operator.id,branchId:branch._id,...extra});
 await models.mobileTransactionModel(conn).create(fixture({entrySource:'sms',smsInboxId:id()}));
 const otherOperator=id();
 // A legacy source without metadata must retain its Cash/manual interpretation.
 await models.mobileTransactionModel(conn).collection.insertOne({...fixture({operatorId:new mongoose.Types.ObjectId(otherOperator),amountMinor:mongoose.Types.Decimal128.fromString('10000'),feeMinor:mongoose.Types.Decimal128.fromString('0')}),branchId:branch._id,createdAt:new Date(),status:'pending_verification'});
 await models.mobileTransactionModel(conn).create(fixture({branchId:second._id,currency:'UGX',amountMinor:'5000'}));
 await models.mobileTransactionModel(conn).create(fixture({amountMinor:'9999',createdAt:new Date(`${yesterday}T12:00:00Z`)}));
 const selected={from:today,to:today};
 const report=await workspace.workspace(conn,operator,selected);
 assert.equal(report.summary.total,6);assert.equal(report.summary.activeCount,5);assert.equal(report.summary.voidedCount,1);assert.equal(report.summary.smsCount,1);assert.equal(report.summary.manualCount,5);
 assert.equal(report.summary.byCurrency.length,1);assert.equal(report.summary.byCurrency[0].volumeMinor,'32415');assert.equal(report.summary.byCurrency[0].feesMinor,'140');assert.equal(report.summary.byCurrency[0].cashImpactMinor,'1550');
 assert.equal(report.networks.find(row=>row.network==='MTN').cashInCount,2);assert.equal(report.networks.find(row=>row.network==='MTN').cashOutCount,1);assert.equal(report.networks.find(row=>row.network==='Africell').volumeMinor,'30045');
 assert.equal((await workspace.workspace(other,operator,selected)).summary.total,0,'tenant connections isolate all report queries');
 const manager={...reviewer,role:'Branch Manager',permissions:permissionsFor('Branch Manager')};
 const branchReport=await workspace.workspace(conn,manager,selected);assert.equal(branchReport.summary.total,7);assert.equal(branchReport.summary.byCurrency[0].cashImpactMinor,'11550');
 const owner={id:id(),role:'Tenant Owner',permissions:['*']};
 const ownerReport=await workspace.workspace(conn,owner,selected);assert.equal(ownerReport.summary.byCurrency.length,2);assert.equal(ownerReport.summary.byCurrency.find(row=>row.currency==='UGX').volumeMinor,'5000');
 assert.equal((await workspace.workspace(conn,operator,{...selected,entrySource:'sms'})).summary.total,1);
 assert.equal((await workspace.workspace(conn,manager,{...selected,entrySource:'manual'})).summary.total,6,'missing source is manual');
 assert.equal((await workspace.workspace(conn,operator,{...selected,network:'Africell'})).summary.total,1);
 assert.equal((await workspace.workspace(conn,operator,{...selected,currency:'UGX'})).summary.total,0);
 assert.equal((await workspace.workspace(conn,operator,{from:yesterday,to:yesterday})).summary.byCurrency[0].volumeMinor,'9999');
 assert.equal((await workspace.workspace(conn,operator,selected,{operation:'cash_out'})).summary.total,2);
 let cursor,ids=[];do{const page=await workspace.workspace(conn,operator,{...selected,cursor},{limit:2});ids.push(...page.records.items.map(row=>String(row._id)));cursor=page.records.nextCursor;}while(cursor);
 assert.equal(ids.length,6);assert.equal(new Set(ids).size,6,'keyset pages neither repeat nor omit same-date records');
 for(const row of (await workspace.workspace(conn,operator,{...selected,cursor:mobile.encodeCursor(ownerReport.records.items.at(-1))})).records.items){assert.equal(String(row.operatorId),operator.id);assert.equal(String(row.branchId),operator.branchId);}
 await assert.rejects(workspace.exportCsv(conn,{...operator,role:'Viewer',permissions:permissionsFor('Viewer')},selected),{status:403});
 assert.equal((await workspace.exportCsv(conn,operator,selected)).count,6,'operator reports retain personal branch scope');
 const exported=await workspace.exportCsv(conn,reviewer,selected);assert.equal(exported.count,7);assert.match(exported.csv,/'=HYPERLINK/);assert.match(exported.csv,/"sms"/);assert.match(exported.csv,/"Bank"/);assert.match(exported.csv,/"voided_internal"/);
 // Mongoose immutable metadata preserves the original receipt after updates.
 await models.mobileTransactionModel(conn).updateOne({_id:recorded[0]._id},{$set:{customerPhone:'+254999999999',paymentMethod:'Bank'}});
 const unchanged=await models.mobileTransactionModel(conn).findById(recorded[0]._id);assert.equal(unchanged.customerPhone,'+254700123456');assert.equal(unchanged.paymentMethod,'Cash');
 const bulkOperator={...reviewer,id:id(),branchId:String(second._id)};
 const bulk=Array.from({length:5001},()=>({...fixture({operatorId:bulkOperator.id,branchId:second._id,currency:'UGX',network:'Airtel',amountMinor:'1',feeMinor:'0'}),createdAt:new Date()}));
 await models.mobileTransactionModel(conn).insertMany(bulk);
 await assert.rejects(workspace.exportCsv(conn,bulkOperator,{...selected,network:'Airtel'}),{status:422});
 assert.equal((await workspace.exportCsv(conn,bulkOperator,{...selected,network:'MTN'})).count,1,'narrowed export remains complete');
 console.log('PASS: Mobile Money real writes/metadata, Cash/Bank/Wallet isolation, void-aware exact totals, currency/network/source/date filters, branch/operator/tenant scopes, keyset pages and complete safe CSV exports.');
}
async function cleanup(){
 if(mongoose.connection.readyState===1&&mongoose.connection.name===scratchName&&/^cfh_mobile_workspace_probe_[a-f0-9]{16}$/.test(scratchName)){
  for(const conn of connections)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();
 }await mongoose.disconnect();
}
main().catch(error=>{console.error('MOBILE WORKSPACE INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Workspace scratch cleanup failed:',error.message);process.exitCode=1;}));
