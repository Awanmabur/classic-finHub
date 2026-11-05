'use strict';
/** Destructive tests are limited to uniquely named scratch DBs on loopback. */
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
const env = require('../src/config/env');
const { verifyReplicaPrimary } = require('../src/config/mongoTopology');

async function main() {
  if (env.nodeEnv === 'production') throw new Error('Integration probe is disabled in NODE_ENV=production');
  const uri = new URL(env.mongoPlatformUri);
  if (uri.protocol !== 'mongodb:' || !['127.0.0.1','localhost','[::1]'].includes(uri.hostname) || uri.host.includes(',')) {
    throw new Error('Integration probe is restricted to local MongoDB. It must never target a production/remote cluster.');
  }
  await mongoose.connect(env.mongoPlatformUri,{serverSelectionTimeoutMS:7000,autoIndex:false});
  const suffix = crypto.randomBytes(7).toString('hex');
  const nameA = `classicfin_probe_a_${suffix}`;
  const nameB = `classicfin_probe_b_${suffix}`;
  const a = mongoose.connection.useDb(nameA,{useCache:false});
  const b = mongoose.connection.useDb(nameB,{useCache:false});
  let session;
  try {
    verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
    // Prepare both collections outside the transaction. Never use real tenant DBs.
    await a.db.createCollection('records');
    await a.db.createCollection('audit');
    await b.db.createCollection('records');
    await a.db.collection('records').createIndex({key:1},{unique:true});
    session = await mongoose.startSession();
    await session.withTransaction(async()=>{
      await a.db.collection('records').insertOne({key:'once',amountMinor:'1000'},{session});
      await a.db.collection('audit').insertOne({action:'test.recorded'},{session});
    });
    assert.equal(await a.db.collection('records').countDocuments({key:'once'}),1);
    assert.equal(await a.db.collection('audit').countDocuments({action:'test.recorded'}),1);
    assert.equal(await b.db.collection('records').countDocuments({key:'once'}),0,'Separate tenant databases must not share records');
    await assert.rejects(a.db.collection('records').insertOne({key:'once',amountMinor:'999'}),err=>err.code===11000);
    try {
      await session.withTransaction(async()=>{
        await a.db.collection('records').insertOne({key:'rollback',amountMinor:'1000'},{session});
        throw new Error('intentional abort');
      });
    } catch(error) { if (error.message !== 'intentional abort') throw error; }
    assert.equal(await a.db.collection('records').countDocuments({key:'rollback'}),0,'Aborted financial transaction must not persist');
    console.log('PASS: replica-set transaction commit and rollback, unique index and cross-tenant database isolation (scratch DBs only).');
  } finally {
    if (session) await session.endSession();
    // Strictly scoped random scratch database names; never drop user data.
    for (const [connection,name] of [[a,nameA],[b,nameB]]) {
      if (!/^classicfin_probe_[ab]_[a-f0-9]{14}$/.test(name)) throw new Error('Unsafe scratch database name');
      try { await connection.db.dropDatabase(); }
      catch (error) { console.error(`Could not clean scratch DB ${name}:`, error.message); process.exitCode=1; }
    }
    await mongoose.disconnect();
  }
}
main().catch(error=>{console.error('MongoDB transaction integration FAILED:',error.message);process.exitCode=1;mongoose.disconnect().catch(()=>{});});
