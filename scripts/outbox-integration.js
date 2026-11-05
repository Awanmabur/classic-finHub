#!/usr/bin/env node
'use strict';
// Scratch-database transaction/concurrency test. Never connects to a live or remote database.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const env=require('../src/config/env');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const OutboxEvent=require('../src/platform/models/OutboxEvent');
const WorkerHeartbeat=require('../src/platform/models/WorkerHeartbeat');
const Audit=require('../src/platform/models/PlatformAuditLog');
const outbox=require('../src/platform/services/outbox.service');
async function main(){
  if(env.nodeEnv==='production')throw new Error('Outbox integration is prohibited in production');
  const uri=new URL(env.mongoPlatformUri);
  if(uri.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(uri.hostname)||uri.host.includes(',')||uri.username||uri.password)
    throw new Error('Outbox integration requires unauthenticated loopback MongoDB only');
  const nonce=crypto.randomBytes(8).toString('hex');
  const database=`classicfin_probe_outbox_${nonce}`;
  uri.pathname='/'+database;
  // All models loaded above use the default connection, now pointing at scratch DB.
  await mongoose.connect(uri.toString(),{serverSelectionTimeoutMS:7000,autoIndex:false});
  try{
    verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
    await Promise.all([OutboxEvent.createIndexes(),Audit.createIndexes(),WorkerHeartbeat.createIndexes()]);
    const tenantId=new mongoose.Types.ObjectId();
    const payload={to:'probe@example.invalid',tenantName:'Scratch Tenant',planName:'Agent',expiresAt:new Date('2026-12-01')};
    const first='subscription.granted:probe-001';
    const session=await mongoose.startSession();
    try{
      await session.withTransaction(async()=>{
        await outbox.enqueue({key:first,type:'subscription.granted',tenantId,payload,session});
      });
      await assert.rejects(session.withTransaction(async()=>{
        await outbox.enqueue({key:'subscription.granted:probe-rollback',type:'subscription.granted',tenantId,payload,session});
        throw new Error('intentional rollback');
      }),/intentional rollback/);
    }finally{await session.endSession();}
    assert.equal(await OutboxEvent.countDocuments({eventKey:first}),1);
    assert.equal(await OutboxEvent.countDocuments({eventKey:'subscription.granted:probe-rollback'}),0);
    const duplicate=await mongoose.startSession();
    try{await assert.rejects(duplicate.withTransaction(async()=>outbox.enqueue({key:first,type:'subscription.granted',tenantId,payload,session:duplicate})),e=>e.code===11000);}
    finally{await duplicate.endSession();}
    // Atomic competing workers: exactly one claim at this instant.
    const now=new Date();
    const claims=await Promise.all([outbox.claim({workerId:'worker-one',now}),outbox.claim({workerId:'worker-two',now})]);
    assert.equal(claims.filter(Boolean).length,1);
    const claimed=claims.find(Boolean);
    const transient=await outbox.fail(claimed,Object.assign(new Error('rate limited'),{providerStatus:429}),{now});
    assert.equal(transient.state,'pending');
    assert.equal((await OutboxEvent.findOne({eventKey:first})).state,'pending');
    const nextTime=new Date(Date.now()+10*60*1000);
    // Check that an awaited retry uses its stable key and stores acceptance.
    const sent=[];
    const sentResult=await outbox.processOne({workerId:'worker-three',now:()=>nextTime,deliver:async msg=>{
      sent.push(msg);return {provider:'resend',messageId:'integration-accepted-001'};
    }});
    assert.equal(sentResult.state,'accepted');
    assert.equal(sent[0].idempotencyKey,`cfh:${first}`);
    assert.equal((await OutboxEvent.findOne({eventKey:first})).providerAcceptance.messageId,'integration-accepted-001');
    // Lease fencing: a former worker cannot complete after a replacement takes ownership.
    const leaseKey='subscription.granted:probe-lease';
    const s2=await mongoose.startSession();
    try{await s2.withTransaction(()=>outbox.enqueue({key:leaseKey,type:'subscription.granted',tenantId,payload,session:s2}));}
    finally{await s2.endSession();}
    const a=await outbox.claim({workerId:'worker-A',now:nextTime});
    assert.equal(a.eventKey,leaseKey);
    const b=await outbox.claim({workerId:'worker-B',now:new Date(nextTime.valueOf()+outbox.WORKER_LEASE_MS+1000)});
    assert.equal(b.eventKey,leaseKey);
    assert.notEqual(a.leaseToken,b.leaseToken);
    assert.equal(await outbox.accept(a,{provider:'resend',messageId:'old-worker-accepted'},{now:new Date(nextTime.valueOf()+outbox.WORKER_LEASE_MS+1000)}),false);
    const finalized=await outbox.fail(b,Object.assign(new Error('recipient invalid'),{providerStatus:422}),{now:new Date(nextTime.valueOf()+outbox.WORKER_LEASE_MS+1000)});
    assert.equal(finalized.state,'dead');
    assert.equal((await OutboxEvent.findOne({eventKey:leaseKey})).state,'dead');
    const actor={id:String(new mongoose.Types.ObjectId()),name:'Recovery Admin',permissions:['*']};
    await assert.rejects(outbox.retryDead({id:b._id,actor:{...actor,permissions:[]},reason:'Controlled delivery recovery test authorization'}),e=>e.status===403);
    await outbox.retryDead({id:b._id,actor,reason:'Controlled delivery recovery test authorization'});
    assert.equal((await OutboxEvent.findById(b._id)).state,'pending');
    assert.equal(await Audit.countDocuments({action:'outbox.dead_letter_retried'}),1);
    // Expired FINAL attempt cannot get stuck in processing forever.
    await OutboxEvent.updateOne({_id:b._id},{$set:{state:'processing',attempts:8,leaseUntil:new Date(Date.now()-1000)}});
    await outbox.expireExhausted();
    assert.equal((await OutboxEvent.findById(b._id)).state,'dead');
    console.log('PASS: transactional outbox commit/rollback, dedup index, competing workers, retry delay, provider acceptance, lease fencing, dead-letter and audited redrive (scratch database only)');
  }finally{
    if(!/^classicfin_probe_outbox_[a-f0-9]{16}$/.test(database))throw new Error('Refusing unsafe database cleanup');
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
}
main().catch(e=>{console.error('Outbox integration FAILED:',e.message);process.exitCode=1;mongoose.disconnect().catch(()=>{});});
