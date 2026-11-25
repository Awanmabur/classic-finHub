'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {publishWorkerId,workerFilter}=require('../src/config/workerReadiness');

test('container readiness requires the current worker heartbeat, while fleet checks still match any worker in the class',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cfh-worker-readiness-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const now=Date.now();
 for(const [kind,freshness] of [['outbox',45000],['notification',45000],['tenant-backup',60000]]){
  const previous=kind+'-'+crypto.randomUUID();
  const current=kind+'-'+crypto.randomUUID();
  assert((await workerFilter(kind,{now})).workerId.test(previous));
  await assert.rejects(()=>workerFilter(kind,{directory,instance:true,now}),{code:'ENOENT'});
  await publishWorkerId(kind,previous,{directory});
  await publishWorkerId(kind,current,{directory});
  const filter=await workerFilter(kind,{directory,instance:true,now});
  assert.equal(filter.workerId,current);
  assert.notEqual(filter.workerId,previous);
  assert.equal(filter.seenAt.$gte.valueOf(),now-freshness);
  await publishWorkerId(kind,'outbox', {directory});
  await assert.rejects(()=>workerFilter(kind,{directory,instance:true,now}),/Invalid local worker identity/);
 }
});
