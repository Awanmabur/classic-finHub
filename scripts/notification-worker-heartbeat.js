#!/usr/bin/env node
'use strict';
// Liveness-only release probe. Queue health/alerts are independently monitored
// by notification:doctor, not confused with a rollback-ready application.
const mongoose=require('mongoose');
const WorkerHeartbeat=require('../src/platform/models/WorkerHeartbeat');
async function main(){
 const uri=process.env.MONGO_NOTIFICATION_WORKER_URI;
 if(!uri)throw Error('Notification worker database URI missing');
 const parsed=new URL(uri);
 if(!['mongodb:','mongodb+srv:'].includes(parsed.protocol)||parsed.pathname.length<2)throw Error('Invalid worker URI');
 await mongoose.connect(uri,{serverSelectionTimeoutMS:5000,maxPoolSize:2,autoIndex:false});
 const count=await WorkerHeartbeat.countDocuments({workerId:/^notification-/,seenAt:{$gte:new Date(Date.now()-45000)}});
 console.log(JSON.stringify({event:'notification.worker_ready',ready:count>0,activeWorkers:count}));
 if(!count)process.exitCode=2;
}
main().catch(error=>{console.error(JSON.stringify({event:'notification.worker_ready',ready:false,reason:'worker_or_database_unavailable'}));process.exitCode=1;}).finally(()=>mongoose.disconnect().catch(()=>{}));
