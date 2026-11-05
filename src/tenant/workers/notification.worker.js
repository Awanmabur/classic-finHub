'use strict';
// Independent worker, no HTTP port and no web session/MFA secrets.
// Its MongoDB credential needs read-only Tenant access + narrowly scoped
// notification reads/writes across tenant DBs. Do not share the web user.
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const Tenant=require('../../platform/models/Tenant');
const WorkerHeartbeat=require('../../platform/models/WorkerHeartbeat');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
function getTenantConnection(slug){return mongoose.connection.useDb(tenantDbNameFromSlug(slug),{useCache:true});}
const {verifyReplicaPrimary}=require('../../config/mongoTopology');
const service=require('../services/notification.service');
const workerId=`notification-${crypto.randomUUID()}`;
const every=Number(process.env.NOTIFICATION_POLL_MS||5000);
if(!Number.isSafeInteger(every)||every<1000||every>60000)throw new Error('NOTIFICATION_POLL_MS must be 1000–60000');
let closing=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{closing=true;});
async function connect(){
 const uri=process.env.MONGO_NOTIFICATION_WORKER_URI;
 if(!uri)throw new Error('MONGO_NOTIFICATION_WORKER_URI is required for the notification worker');
 const parsed=new URL(uri);
 if(!['mongodb:','mongodb+srv:'].includes(parsed.protocol)||parsed.pathname.length<2)throw new Error('Notification worker URI requires a named MongoDB database');
 mongoose.set('strictQuery',true);
 await mongoose.connect(uri,{serverSelectionTimeoutMS:7000,maxPoolSize:10,autoIndex:false,retryWrites:true});
 verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await WorkerHeartbeat.createIndexes();
}
async function sweep(){
 let processed=0,scanned=0;
 for await (const tenant of Tenant.find({status:{$in:['active','trial','past_due','suspended']}})
  .select('slug status subscription enabledModules moduleGrants').lean().cursor()){
  if(closing)break;
  scanned++;
  if(scanned>10000)throw new Error('Notification worker tenant scan safety limit exceeded');
  try{
   const conn=getTenantConnection(tenant.slug);
   const result=await service.processOne(conn,tenant,workerId);
   if(result)processed++;
  }catch(error){
   // Logs never include message bodies, addresses, or tenant names.
   console.error(JSON.stringify({event:'notifications.worker_error',kind:error?.name||'Error'}));
  }
 }
 return {processed,scanned};
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function run(){
 await connect();
 console.log(JSON.stringify({event:'notifications.worker_started',workerId}));
 while(!closing){
  try{
   await WorkerHeartbeat.updateOne({workerId},{$set:{seenAt:new Date(),expiresAt:new Date(Date.now()+90000)}},{upsert:true});
   const result=await sweep();
   if(result.processed)console.log(JSON.stringify({event:'notifications.processed',processed:result.processed}));
  }catch(error){console.error(JSON.stringify({event:'notifications.sweep_error',kind:error?.name||'Error'}));}
  if(!closing)await sleep(every);
 }
 await WorkerHeartbeat.deleteOne({workerId}).catch(()=>{});
 await mongoose.disconnect();
}
run().catch(error=>{console.error(JSON.stringify({event:'notifications.start_failed',kind:error?.name||'Error'}));process.exitCode=1;mongoose.disconnect().catch(()=>{});});
