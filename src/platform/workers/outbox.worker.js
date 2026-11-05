'use strict';
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const {connectWorkerMongo}=require('../../config/workerMongo');
const {verifyReplicaPrimary}=require('../../config/mongoTopology');
const OutboxEvent=require('../models/OutboxEvent');
const WorkerHeartbeat=require('../models/WorkerHeartbeat');
const {processOne,expireExhausted}=require('../services/outbox.service');
const workerId=`outbox-${crypto.randomUUID()}`;
const pollMs=Number(process.env.OUTBOX_POLL_MS||2000);
if(!Number.isSafeInteger(pollMs)||pollMs<500||pollMs>60000)throw new Error('OUTBOX_POLL_MS must be 500–60000 milliseconds');
let closing=false;
let lastBeat=0;
async function heartbeat(now){
  if(now.valueOf()-lastBeat<10000)return;
  await WorkerHeartbeat.updateOne({workerId},{$set:{seenAt:now,expiresAt:new Date(now.valueOf()+90000)}}, {upsert:true});
  lastBeat=now.valueOf();
}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function run(){
  await connectWorkerMongo();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
  await Promise.all([OutboxEvent.createIndexes(),WorkerHeartbeat.createIndexes()]);
  console.log(JSON.stringify({event:'outbox.worker_started',workerId}));
  let nextSweep=0;
  while(!closing){
    try{
      const now=new Date();
      await heartbeat(now);
      if(now.valueOf()>=nextSweep){await expireExhausted(now);nextSweep=now.valueOf()+30000;}
      const result=await processOne({workerId});
      if(result){console.log(JSON.stringify({event:'outbox.work_item',state:result.state,eventKey:result.eventKey,failureCode:result.failureCode||undefined}));continue;}
    }catch(error){
      // Log only error class, never provider message, customer address or payload.
      console.error(JSON.stringify({event:'outbox.worker_error',kind:error?.name||'Error'}));
    }
    if(!closing)await sleep(pollMs);
  }
  await WorkerHeartbeat.deleteOne({workerId}).catch(()=>{});
  await mongoose.disconnect();
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{closing=true;});
run().catch(e=>{console.error(JSON.stringify({event:'outbox.start_failed',kind:e?.name||'Error'}));process.exitCode=1;mongoose.disconnect().catch(()=>{});});
