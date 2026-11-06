#!/usr/bin/env node
'use strict';
// Reporting query fixtures only: no business posting is bypassed in production.
// Destructive cleanup is restricted to this random unauthenticated loopback DB.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto'),mongoose=require('mongoose');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Reporting integration requires one unauthenticated loopback MongoDB server');
const nonce=crypto.randomBytes(8).toString('hex'),slug=`probe-report-cash-${nonce}`;
const scratchName=require('../src/config/tenantDatabaseName').tenantDbNameFromSlug(slug);
configured.pathname='/'+scratchName;process.env.NODE_ENV='test';
const reports=require('../src/tenant/services/approvedReports.service'),core=require('../src/tenant/models');
const commercial=require('../src/platform/services/commercial.service');
const {permissionsFor}=require('../src/config/roles');
const oid=()=>new mongoose.Types.ObjectId(),decimal=value=>mongoose.Types.Decimal128.fromString(String(value));
let conn;
async function main(){
 conn=await mongoose.createConnection(configured.toString(),{autoIndex:false}).asPromise();
 const funds=require('../src/tenant/treasury/models').models(conn),tenantId=oid(),branchId=oid(),operatorId=oid(),reviewerId=oid(),otherBranch=oid(),otherOperator=oid(),otherTenant=oid();
 const modules=['reports','mobile_money','banking','forex','money_transfer','expenses'];
 const terms={code:'cash_report_probe',name:'Cash reporting probe',priceMonthly:1,priceYearly:10,currency:'USD',trialMonths:0,modules,
  limits:{users:10,branches:5,transactionsPerMonth:100,smsPerMonth:0,storageMb:500},description:'Scratch report query integration'};
 const tenant={_id:tenantId,slug,dbName:conn.name,plan:terms.code,status:'active',enabledModules:modules,subscription:{...commercial.planSnapshot({...commercial.asPlanVersion(terms),status:'published'}),status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-86400000),periodEnd:new Date(Date.now()+86400000)}};
 const actor={id:String(operatorId),branchId:String(branchId),role:'Reports Analyst',permissions:permissionsFor('Reports Analyst'),allowedModules:modules};
 const day=new Date(Date.now()-86400000).toISOString().slice(0,10),event=new Date(day+'T12:00:00.000Z'),range={from:day,to:day};
 const dateRange=require('../src/tenant/services/mobileMoney.service').dateBounds(range),scope={branchId:String(branchId),operatorId:String(operatorId)};
 const accounts=[];
 function account({kind='cash',branch=branchId,operator=operatorId,currency='UGX',tenant=tenantId}={}){const row={_id:oid(),tenantId:tenant,branchId:branch,operatorId:operator,kind,currency,code:'A'+accounts.length,ledgerAccountId:oid()};accounts.push(row);return row;}
 const cash=account(),cashUsd=account({currency:'USD'}),bank=account({kind:'bank'}),otherCash=account({operator:otherOperator}),otherBranchCash=account({branch:otherBranch}),foreignCash=account({tenant:otherTenant});
 await funds.account.collection.insertMany(accounts);
 const batches=[],movements=[];
 function movement(sourceType,delta,{fund=cash,at=event,createdAt=event,batchTenant=tenantId,tenant=tenantId,operator=fund.operatorId}={}){
  const batch={_id:oid(),tenantId:batchTenant,branchId:fund.branchId,operatingActorId:operator,actorId:reviewerId,sourceType,sourceRef:'REPORT:'+oid(),createdAt};batches.push(batch);
  movements.push({_id:oid(),tenantId:tenant,branchId:fund.branchId,accountId:fund._id,batchId:batch._id,sourceType,currency:fund.currency,deltaMinor:decimal(delta),occurredAt:at,createdAt,actorId:reviewerId});
 }
 movement('banking','10000');movement('forex','-3750');movement('money_transfer','3100');movement('money_transfer','-3000');
 movement('mobile_money','1010');movement('mobile_money','-1010');movement('expenses','-500');
 movement('banking','9007199254740993',{fund:cashUsd});
 movement('banking','1000000',{fund:bank});movement('banking','777',{fund:otherCash});movement('banking','888',{fund:otherBranchCash});
 movement('banking','999',{fund:foreignCash,tenant:otherTenant,batchTenant:otherTenant});
 movement('banking','111',{at:new Date(event.getTime()-86400000)});
 movement('banking','222',{createdAt:new Date(event.getTime()+86400000)});
 movement('banking','333',{batchTenant:otherTenant});movement('treasury_adjustment','444');
 await funds.batch.collection.insertMany(batches);await funds.movement.collection.insertMany(movements);
 const rows=await reports.postedCash(conn,tenant,scope,dateRange,modules);
 const find=(source,currency='UGX')=>rows.find(row=>row.sourceType===source&&row.currency===currency);
 assert.equal(find('banking').netMinor,'10222');assert.equal(find('banking').count,2);
 assert.equal(find('banking','USD').netMinor,'9007199254740993');
 assert.equal(find('forex').netMinor,'-3750');assert.equal(find('forex').cashOutMinor,'3750');
 assert.equal(find('money_transfer').netMinor,'100');assert.equal(find('money_transfer').cashInMinor,'3100');assert.equal(find('money_transfer').cashOutMinor,'3000');
 assert.equal(find('mobile_money').netMinor,'0');assert.equal(find('mobile_money').count,2);assert.equal(find('expenses').netMinor,'-500');
 assert(!rows.some(row=>row.sourceType==='treasury_adjustment'));
 assert.deepEqual(await reports.postedCash(conn,tenant,scope,dateRange,['reports','workspace']),[]);
 assert((await reports.postedCash(conn,tenant,scope,dateRange,['banking'])).every(row=>row.sourceType==='banking'));
 // Only original legacy records appear beside posted Treasury movements.
 const mobileRows=[];
 function legacy(operation,amount,{physical=null,fundingState='legacy_untracked',status='pending_verification',paymentMethod='Cash',operator=operatorId,branch=branchId}={}){
  mobileRows.push({_id:oid(),operatorId:operator,branchId:branch,currency:'UGX',operation,network:'MTN',networkReference:'LEGACY:'+oid(),idempotencyKey:crypto.randomUUID(),
   amountMinor:decimal(amount),feeMinor:decimal('7'),physicalCashMovementMinor:physical===null?null:decimal(physical),fundingState,status,correctionState:'none',paymentMethod,createdAt:event});
 }
 legacy('cash_in','100',{physical:'107'});legacy('cash_out','20');legacy('cash_in','1000',{physical:'1010',fundingState:'book_recorded'});
 legacy('cash_in','999',{status:'voided_internal'});legacy('cash_in','999',{paymentMethod:'Wallet Balance'});legacy('cash_in','555',{operator:otherOperator});legacy('cash_in','666',{branch:otherBranch});
 await core.mobileTransactionModel(conn).collection.insertMany(mobileRows);
 assert.deepEqual(await reports.cashImpact(conn,scope,dateRange,{legacyOnly:true}),{UGX:'87'});
 assert.deepEqual(await reports.cashImpact(conn,scope,dateRange),{UGX:'1097'});
 // Real report dispatch constrains cash totals to the selected subscribed source.
 const banking=await reports.generate(conn,tenant,actor,'banking',range);
 assert(banking.postedCash.length);assert(banking.postedCash.every(row=>row.sourceType==='banking'));
 assert.equal(banking.postedCash.find(row=>row.currency==='UGX').netMinor,'10999','branch analyst can include both operators, but not another branch');
 const limited={...tenant,enabledModules:['reports','forex'],subscription:{...tenant.subscription,modules:['reports','forex']}};
 const unavailable=await reports.generate(conn,limited,actor,'banking',range);assert.equal(unavailable.sourceAvailable,false);assert.deepEqual(unavailable.postedCash,[]);
 assert.match(reports.csv(banking),/Net cash movement minor units/);assert.match(reports.csv(banking),/9007199254740993/);
 console.log('PASS: Posted report cash impacts include exact collected fees, reversals and historical event dates; exclude bank/wallet assets, other operators/branches/tenants and unavailable sources; legacy MoMo never double counts funded records.');
}
main().catch(error=>{console.error('Reporting cash integration FAILED:',error.stack||error.message);process.exitCode=1;}).finally(async()=>{
 try{if(conn?.readyState===1){if(conn.name!==scratchName||!scratchName.includes(nonce))throw Error('Unsafe report scratch cleanup');await conn.dropDatabase();await conn.close();}}catch(error){console.error('Report cleanup failed:',error.message);process.exitCode=1;}
});
