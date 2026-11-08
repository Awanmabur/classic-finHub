#!/usr/bin/env node
'use strict';
// Read-only worker / queue health check, suitable for external monitoring.
// Never reveals recipients, message contents, or provider credentials.
const mongoose=require('mongoose');
const Tenant=require('../src/platform/models/Tenant');
const WorkerHeartbeat=require('../src/platform/models/WorkerHeartbeat');
const {tenantDbNameFromSlug}=require('../src/config/tenantDatabaseName');
const {notificationMessageModel}=require('../src/tenant/models');
const {hasModuleForUser}=require('../src/tenant/services/moduleAccess.service');
const MAX_TENANTS=10000;
async function transferQueueCounts(conn,stale){
 // Only unpaid, collected transfers can still need their payout instruction.
 // Never return bodies, phone numbers, PINs, identifiers or provider secrets.
 const rows=await require('../src/tenant/transferSms/models').model(conn).aggregate([
  {$match:{state:{$in:['pending','retry','processing','dead','not_configured','uncertain']}}},
  {$lookup:{from:require('../src/tenant/models').transferOrderModel(conn).collection.name,localField:'sourceId',foreignField:'_id',as:'source'}},
  {$unwind:'$source'},
  {$match:{'source.status':'collected_manual',$expr:{$and:[{$eq:['$source.branchId','$branchId']},{$eq:['$source.manualCollectionExecutionId','$executionId']}]}}},
  {$group:{_id:'$state',count:{$sum:1},overdue:{$sum:{$cond:[{$lt:['$createdAt',stale]},1,0]}}}}
 ]).option({maxTimeMS:5000});
 const counts={overdue:0,dead:0,notConfigured:0,uncertain:0};
 for(const row of rows){
  if(['pending','retry','processing'].includes(row._id))counts.overdue+=row.overdue;
  else if(row._id==='not_configured')counts.notConfigured+=row.count;
  else counts[row._id]+=row.count;
 }
 return counts;
}
async function inspect({connect=true}={}){
 if(connect){
  const uri=process.env.MONGO_NOTIFICATION_WORKER_URI;
  if(!uri)throw Error('MONGO_NOTIFICATION_WORKER_URI required');
  const parsed=new URL(uri);
  if(!['mongodb:','mongodb+srv:'].includes(parsed.protocol)||parsed.pathname.length<2)throw Error('Invalid worker database URI');
  await mongoose.connect(uri,{serverSelectionTimeoutMS:7000,maxPoolSize:10,autoIndex:false});
 }
 const now=new Date(),stale=new Date(now.getTime()-15*60*1000),live=new Date(now.getTime()-90*1000);
 const workers=await WorkerHeartbeat.countDocuments({workerId:/^notification-/,seenAt:{$gt:live}});
 let scanned=0,enabled=0,overdue=0,dead=0,smsEnabled=0;
 const smsCounts={overdue:0,dead:0,notConfigured:0,uncertain:0};
 for await(const tenant of Tenant.find({status:{$in:['active','trial','past_due','suspended']}})
  .select('slug status subscription enabledModules moduleGrants').lean().cursor()){
  if(++scanned>MAX_TENANTS)throw Error('Tenant health scan limit exceeded');
  const email=hasModuleForUser(tenant,{role:'Tenant Owner'},'notifications'),sms=hasModuleForUser(tenant,{role:'Tenant Owner'},'money_transfer');
  if(!email&&!sms)continue;
  enabled++;
  const conn=mongoose.connection.useDb(tenantDbNameFromSlug(tenant.slug),{useCache:true});
  if(email){
   const Model=notificationMessageModel(conn);
   const [staleCount,deadCount]=await Promise.all([
    Model.countDocuments({emailState:{$in:['pending','retry','processing']},createdAt:{$lt:stale}}),
    Model.countDocuments({emailState:'dead'})
   ]);
   overdue+=staleCount;dead+=deadCount;
  }
  if(sms){smsEnabled++;const counts=await transferQueueCounts(conn,stale);for(const key of Object.keys(smsCounts))smsCounts[key]+=counts[key];}
 }
 const issues=[];
 if(enabled&&workers<1)issues.push('missing-notification-worker-heartbeat');
 if(overdue)issues.push('stale-notification-email-queue');
 if(dead)issues.push('notification-dead-letter-records');
 if(smsCounts.overdue)issues.push('stale-transfer-sms-queue');
 if(smsCounts.dead)issues.push('transfer-sms-dead-letter-records');
 if(smsCounts.notConfigured)issues.push('transfer-sms-not-configured');
 if(smsCounts.uncertain)issues.push('transfer-sms-submission-uncertain');
 return {healthy:issues.length===0,scannedTenants:scanned,subscribedTenants:enabled,activeWorkers:workers,
  overdueEmails:overdue,deadEmails:dead,transferSmsTenants:smsEnabled,transferSms:smsCounts,issues};
}
if(require.main===module)inspect().then(result=>{
 console.log(JSON.stringify({event:'notification.health',...result}));if(!result.healthy)process.exitCode=1;
}).catch(error=>{console.error(JSON.stringify({event:'notification.health_failed',kind:error?.name||'Error'}));process.exitCode=1;
}).finally(()=>mongoose.disconnect().catch(()=>{}));
module.exports={inspect,transferQueueCounts,MAX_TENANTS};
