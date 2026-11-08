#!/usr/bin/env node
'use strict';
// Alias/base configuration with real cross-database transactions. Cleanup is
// restricted to random, unauthenticated loopback scratch databases.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const source=new URL(process.env.MONGO_PLATFORM_URI||process.env.PLATFORM_DB_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||source.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(source.hostname)||source.host.includes(',')||source.username||source.password)throw Error('Mongo configuration integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),platformName=`cfh_mongo_alias_${nonce}`,slugs=[`mongo-alias-a-${nonce}`,`mongo-alias-b-${nonce}`];
source.pathname='/'+platformName;process.env.NODE_ENV='test';process.env.PLATFORM_DB_URI=source.toString();process.env.MONGO_PLATFORM_URI='';
const base=new URL(source);base.pathname='/';base.searchParams.set('appName','tenant-link-proof');process.env.MONGO_URI_BASE=base.toString();
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection,getTenantUri,tenantDbNameFromSlug}=require('../src/config/mongo');
const expectedTenants=slugs.map(tenantDbNameFromSlug);
async function main(){
 const platform=await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await platform.db.admin().command({hello:1}));
 assert.equal(platform.name,platformName);
 const [first,second]=slugs.map(getTenantConnection);
 assert.notEqual(first.name,second.name);assert.equal(getTenantConnection(slugs[0]),first);
 assert.equal(platform.getClient(),first.getClient());assert.equal(platform.getClient(),second.getClient(),'all tenant handles reuse the platform MongoClient');
 for(let index=0;index<slugs.length;index++)assert.equal(new URL(getTenantUri(slugs[index])).pathname,'/'+expectedTenants[index]);
 assert.throws(()=>getTenantConnection('../untrusted/database'),/Invalid tenant slug/);
 const authorization=platform.db.collection('authorization_probe'),ledger=first.db.collection('ledger_probe');
 await platform.db.createCollection('authorization_probe');await first.db.createCollection('ledger_probe');await second.db.createCollection('ledger_probe');
 const session=await first.startSession();
 try{
  await session.withTransaction(async()=>{
   await authorization.insertOne({reference:'committed',decision:'authorized'},{session});
   await ledger.insertOne({reference:'committed',currency:'UGX',amountMinor:'1000'},{session});
  });
  assert.equal(await authorization.countDocuments({reference:'committed'}),1);assert.equal(await ledger.countDocuments({reference:'committed'}),1);
  assert.equal(await second.db.collection('ledger_probe').countDocuments(),0,'another tenant must not see the first ledger');
  await assert.rejects(session.withTransaction(async()=>{
   await authorization.insertOne({reference:'aborted',decision:'authorized'},{session});
   await ledger.insertOne({reference:'aborted',currency:'UGX',amountMinor:'1000'},{session});
   throw Error('controlled rollback');
  }),/controlled rollback/);
  assert.equal(await authorization.countDocuments({reference:'aborted'}),0);assert.equal(await ledger.countDocuments({reference:'aborted'}),0);
 }finally{await session.endSession();}
 console.log('PASS: PLATFORM_DB_URI and compatible MONGO_URI_BASE derive separate trusted tenant database links while sharing one MongoClient; cross-platform/tenant commit and rollback, cached handles and tenant isolation pass.');
}
async function cleanup(){
 if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_mongo_alias_[a-f0-9]{16}$/.test(platformName)){
  for(let index=0;index<slugs.length;index++){
   const conn=getTenantConnection(slugs[index]);if(conn.name!==expectedTenants[index]||!conn.name.endsWith(nonce+'_db'))throw Error('Unsafe tenant scratch cleanup');await conn.db.dropDatabase();
  }
  await mongoose.connection.db.dropDatabase();
 }
 await mongoose.disconnect();
}
main().catch(error=>{console.error('Mongo configuration integration FAILED:',error.name||'Error');process.exitCode=1;}).finally(()=>cleanup().catch(()=>{console.error('Mongo configuration scratch cleanup failed');process.exitCode=1;}));
