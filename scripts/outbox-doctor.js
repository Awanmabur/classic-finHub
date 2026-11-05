#!/usr/bin/env node
'use strict';
// Read-only operational probe for scheduled monitoring. A failing exit code must trigger an external alert.
const mongoose=require('mongoose');
// The worker environment must not require a web SESSION_SECRET or MFA encryption key.
// Resolve only the appropriate connector, to avoid loading web-only environment validation.
const connect = process.env.MONGO_WORKER_URI
  ? require('../src/config/workerMongo').connectWorkerMongo
  : require('../src/config/mongo').connectPlatformMongo;
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const Event=require('../src/platform/models/OutboxEvent');
const Heartbeat=require('../src/platform/models/WorkerHeartbeat');
async function main(){
  await connect();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1,maxTimeMS:2000}));
  const now=new Date();
  const [workers,oldest,dead,stuck]=await Promise.all([
    Heartbeat.countDocuments({seenAt:{$gte:new Date(now-45000)}}),
    Event.findOne({state:'pending',availableAt:{$lt:new Date(now-300000)}}).sort({availableAt:1}).select('_id').lean(),
    Event.countDocuments({state:'dead'}),
    Event.countDocuments({state:'processing',leaseUntil:{$lt:now}})
  ]);
  const errors=[];
  if(workers<1)errors.push('no_recent_worker_heartbeat');
  if(oldest)errors.push('pending_job_over_five_minutes');
  if(dead>0)errors.push('dead_letter_events_present');
  if(stuck>0)errors.push('expired_worker_leases');
  console.log(JSON.stringify({event:'outbox.health',healthy:errors.length===0,activeWorkers:workers,deadLetters:dead,
    expiredLeases:stuck,oldestPendingExceeded5m:Boolean(oldest),issues:errors}));
  if(errors.length)process.exitCode=2;
}
main().catch(e=>{console.error(JSON.stringify({event:'outbox.health',healthy:false,reason:'database_unavailable',type:e.name}));process.exitCode=1;}).finally(()=>mongoose.disconnect().catch(()=>{}));
