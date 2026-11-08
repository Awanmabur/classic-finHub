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
test('development worker may use platform alias while production still requires its own principal',()=>{
  const alias='mongodb://localhost:27018/platform_alias?replicaSet=rs0';
  assert.equal(workerUri({NODE_ENV:'test',PLATFORM_DB_URI:alias}),alias);
  assert.throws(()=>workerUri({NODE_ENV:'production',PLATFORM_DB_URI:alias}),/least-privilege/);
  const multi='mongodb://worker:unit-only@db-a:27017,db-b:27017/platform?replicaSet=rs0';
  assert.equal(workerUri({NODE_ENV:'production',MONGO_WORKER_URI:multi}),multi);
});
