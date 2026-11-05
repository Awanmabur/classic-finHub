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
 let scanned=0,enabled=0,overdue=0,dead=0;
 for await(const tenant of Tenant.find({status:{$in:['active','trial','past_due','suspended']}})
  .select('slug status subscription enabledModules moduleGrants').lean().cursor()){
  if(++scanned>MAX_TENANTS)throw Error('Tenant health scan limit exceeded');
  if(!hasModuleForUser(tenant,{role:'Tenant Owner'},'notifications'))continue;
  enabled++;
  const conn=mongoose.connection.useDb(tenantDbNameFromSlug(tenant.slug),{useCache:true});
  const Model=notificationMessageModel(conn);
  const [staleCount,deadCount]=await Promise.all([
   Model.countDocuments({emailState:{$in:['pending','retry','processing']},createdAt:{$lt:stale}}),
   Model.countDocuments({emailState:'dead'})
  ]);
  overdue+=staleCount;dead+=deadCount;
 }
 const issues=[];
 if(enabled&&workers<1)issues.push('missing-notification-worker-heartbeat');
 if(overdue)issues.push('stale-notification-email-queue');
 if(dead)issues.push('notification-dead-letter-records');
 return {healthy:issues.length===0,scannedTenants:scanned,subscribedTenants:enabled,activeWorkers:workers,
  overdueEmails:overdue,deadEmails:dead,issues};
}
if(require.main===module)inspect().then(result=>{
 console.log(JSON.stringify({event:'notification.health',...result}));if(!result.healthy)process.exitCode=1;
}).catch(error=>{console.error(JSON.stringify({event:'notification.health_failed',kind:error?.name||'Error'}));process.exitCode=1;
}).finally(()=>mongoose.disconnect().catch(()=>{}));
module.exports={inspect,MAX_TENANTS};
