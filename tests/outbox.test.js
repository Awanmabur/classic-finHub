'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const outbox=require('../src/platform/services/outbox.service');
const OutboxEvent=require('../src/platform/models/OutboxEvent');
const payload={to:'Owner@Example.org',tenantName:'Example Finance',planName:'Agent',expiresAt:new Date('2026-12-01')};
const tenantId=new mongoose.Types.ObjectId();
const job={_id:new mongoose.Types.ObjectId(),eventKey:'subscription.granted:test-001',type:'subscription.granted',
  tenantId,payload,state:'processing',attempts:2,maxAttempts:8,leaseToken:'lease-secret'};

test('outbox entry is restricted to supported types and MUST join a transaction',async()=>{
  let created;
  const Model={create:async(docs,opts)=>{created={docs,opts};return docs;}};
  const session={id:'business-transaction'};
  await outbox.enqueue({key:job.eventKey,type:job.type,tenantId,payload,session},Model);
  assert.equal(created.opts.session,session);
  assert.equal(created.docs[0].payload.to,'owner@example.org');
  await assert.rejects(outbox.enqueue({key:'evil:test-001',type:'wallet.transfer',tenantId,payload,session},Model));
  await assert.rejects(outbox.enqueue({key:job.eventKey,type:job.type,tenantId,payload},Model),/session required/);
  await assert.rejects(outbox.enqueue({key:job.eventKey,type:job.type,tenantId,payload:{...payload,to:'invalid'},session},Model));
  const indexes=OutboxEvent.schema.indexes();
  assert(indexes.some(([spec,opts])=>spec.eventKey===1&&opts.unique),'unique deduplication index must exist');
});

test('notifications are explicit provider acceptance, never payment or settled status',()=>{
  const granted=outbox.buildEmail(job);
  assert.match(granted.text,/does not confirm a payment/);
  assert.equal(granted.to,'owner@example.org');
  assert.throws(()=>outbox.buildEmail({...job,payload:{...payload,expiresAt:undefined}}));
  const revoked=outbox.buildEmail({...job,type:'subscription.revoked',payload:{to:payload.to,tenantName:payload.tenantName}});
  assert.match(revoked.subject,/revoked/);
  assert.doesNotMatch(revoked.text,/Your funds were transferred/);
});

test('atomic worker claim supports lease recovery with attempt limit',async()=>{
  let capture;
  await outbox.claim({workerId:'worker-a',now:new Date('2026-11-03T12:00:00Z'),token:'token-a'},
    {findOneAndUpdate:async(...args)=>{capture=args;return job;}});
  assert.equal(capture[1].$inc.attempts,1);
  assert.equal(capture[1].$set.leaseToken,'token-a');
  assert.equal(capture[0].$or[1].state,'processing');
  assert.deepEqual(capture[0].$or[1].$expr,{$lt:['$attempts','$maxAttempts']});
  assert.equal(capture[2].new,true);
  await assert.rejects(outbox.claim({workerId:'',now:new Date()},{findOneAndUpdate:async()=>job}));
});

test('a worker uses the SAME provider idempotency key after retry, and a lease token fences completion',async()=>{
  let lastFilter,lastUpdate;
  const Model={findOneAndUpdate:async()=>job,updateOne:async(filter,update)=>{lastFilter=filter;lastUpdate=update;return {modifiedCount:1};}};
  const sent=[];
  const now=()=>new Date('2026-11-03T12:00:00Z');
  const output=await outbox.processOne({workerId:'worker-a',Model,now,deliver:async args=>{
    sent.push(args);return {provider:'resend',messageId:'accepted-test-1'};
  }});
  assert.equal(output.state,'accepted');
  assert.equal(sent[0].idempotencyKey,`cfh:${job.eventKey}`);
  assert.equal(lastFilter.leaseToken,job.leaseToken);
  assert.equal(lastUpdate.$set.state,'accepted');
  assert.equal(lastUpdate.$set.providerAcceptance.messageId,'accepted-test-1');
  assert.equal(lastUpdate.$set.purgeAt.toISOString().slice(0,10),'2027-02-01');
});

test('temporary provider failures retry, permanent errors and exhausted attempts dead-letter',async()=>{
  let lastUpdate;
  const Model={findOneAndUpdate:async()=>job,updateOne:async(filter,update)=>{lastUpdate=update;return {modifiedCount:1};}};
  const now=()=>new Date('2026-11-03T12:00:00Z');
  const throttled=await outbox.processOne({workerId:'worker-a',Model,now,deliver:async()=>{throw Object.assign(new Error('rate limited'),{providerStatus:429});}});
  assert.equal(throttled.state,'pending');
  assert.equal(lastUpdate.$set.failureCode,'provider_rate_limited');
  assert(lastUpdate.$set.availableAt>now());
  const permanent=await outbox.processOne({workerId:'worker-a',Model,now,deliver:async()=>{throw Object.assign(new Error('bad address'),{providerStatus:422});}});
  assert.equal(permanent.state,'dead');
  assert.equal(lastUpdate.$set.failureCode,'provider_permanent_rejection');
  const last=await outbox.fail({...job,attempts:8},new Error('disconnected'),{Model,now:now()});
  assert.equal(last.state,'dead');
  assert.equal(outbox.classifyFailure({code:'MAIL_NOT_CONFIGURED'}).retryable,false);
  assert(outbox.retryDelayMs(4,()=>0)>=240000);
});

test('worker lease exhaustion is reaped, and counters cannot expose event payloads',async()=>{
  let filter,update;
  await outbox.expireExhausted(new Date(),{updateMany:async(f,u)=>{filter=f;update=u;return {modifiedCount:2};}});
  assert.equal(filter.state,'processing');
  assert.equal(update.$set.state,'dead');
  const query={sort:()=>({limit:()=>({select:(arg)=>({lean:async()=>{assert.match(arg,/-payload/);return [];}})})})};
  const Event={countDocuments:async()=>0,find:()=>query};
  const Heartbeat={countDocuments:async()=>1};
  const status=await outbox.metrics({Event,Heartbeat});
  assert.equal(status.liveWorkers,1);
  assert.deepEqual(status.recent,[]);
});
