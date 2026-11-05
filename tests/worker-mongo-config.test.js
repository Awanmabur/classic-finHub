'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {workerUri}=require('../src/config/workerMongo');
test('production worker requires distinct database credentials rather than implicit web connection',()=>{
  assert.throws(()=>workerUri({NODE_ENV:'production',MONGO_PLATFORM_URI:'mongodb://localhost:27017/app'}),/least-privilege/);
  assert.equal(workerUri({NODE_ENV:'production',MONGO_WORKER_URI:'mongodb://worker:test@localhost:27017/classicfin_platform_db'}),
    'mongodb://worker:test@localhost:27017/classicfin_platform_db');
  assert.throws(()=>workerUri({NODE_ENV:'production',MONGO_WORKER_URI:'mongodb://localhost:27017/'}),/explicitly name/);
});
