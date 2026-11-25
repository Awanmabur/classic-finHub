#!/usr/bin/env node
'use strict';
// Lightweight release readiness probe. Detailed queue failures belong in worker:doctor.
const mongoose=require('mongoose');
const {connectWorkerMongo}=require('../src/config/workerMongo');
const {workerFilter}=require('../src/config/workerReadiness');
const WorkerHeartbeat=require('../src/platform/models/WorkerHeartbeat');
async function main(){
 const filter=await workerFilter('outbox',{instance:process.argv.includes('--instance')});
 await connectWorkerMongo();
 const count=await WorkerHeartbeat.countDocuments(filter).maxTimeMS(2000);
 console.log(JSON.stringify({event:'worker.ready',ready:count>0,activeWorkers:count}));
 if(!count)process.exitCode=2;
}
main().catch(error=>{console.error(JSON.stringify({event:'worker.ready',ready:false,reason:'database_or_worker_unavailable'}));process.exitCode=1;}).finally(()=>mongoose.disconnect().catch(()=>{}));
