#!/usr/bin/env node
'use strict';
// Compare real MongoDB command counts and resulting index specifications in
// random local databases; no existing database or remote host is permitted.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||process.env.PLATFORM_DB_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Index batching integration requires a single unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),legacyName='cfh_index_legacy_'+nonce,batchName='cfh_index_batch_'+nonce;
configured.pathname='/'+legacyName;
const mongoose=require('mongoose'),core=require('../src/tenant/models');
let connection,batch;
function register(conn){for(const [name,factory]of Object.entries(core))if(name.endsWith('Model'))factory(conn);require('../src/tenant/transferSms/models').model(conn);return Object.values(conn.models);}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
async function actualIndexes(conn){const result={};for(const Model of Object.values(conn.models)){result[Model.modelName]=(await Model.collection.listIndexes().toArray()).map(index=>{const {ns,...spec}=index;return canonical(spec);}).sort((a,b)=>a.name.localeCompare(b.name));}return result;}
async function main(){
 connection=await mongoose.createConnection(configured.toString(),{autoIndex:false,autoCreate:false,monitorCommands:true,serverSelectionTimeoutMS:5000,maxPoolSize:30}).asPromise();
 batch=connection.useDb(batchName,{useCache:true});
 const counts={[legacyName]:0,[batchName]:0};connection.getClient().on('commandStarted',event=>{if(event.commandName==='createIndexes'&&Object.hasOwn(counts,event.databaseName))counts[event.databaseName]++;});
 const legacyModels=register(connection),declared=legacyModels.reduce((sum,Model)=>sum+Model.schema.indexes().length,0);
 const started=Date.now();await Promise.all(legacyModels.map(Model=>Model.createIndexes()));const legacyMs=Date.now()-started;
 const batchStarted=Date.now();await core.ensureTenantIndexes(batch);const batchMs=Date.now()-batchStarted;
 assert.equal(counts[legacyName],declared,'baseline command count must reflect every declared index');
 assert.equal(counts[batchName],Object.keys(batch.models).length,'ordinary batched models need one command each');
 assert(counts[batchName]<counts[legacyName]);
 assert.deepEqual(await actualIndexes(batch),await actualIndexes(connection),'batched indexes must exactly match Mongoose output');
 const User=core.tenantUserModel(batch),row={name:'Index Probe',email:'batch-probe@example.invalid',passwordHash:'synthetic-not-a-password-hash',role:'Tenant Owner'};
 await User.create(row);await assert.rejects(User.create({...row,name:'Duplicate'}),error=>error.code===11000,'unique email must remain enforced');
 const before=counts[batchName];await core.ensureTenantIndexes(batch);assert.equal(counts[batchName],before,'a successful same-process preflight is reused');
 console.log(JSON.stringify({event:'index-batching.verified',collections:Object.keys(batch.models).length,declaredIndexes:declared,legacyCommands:counts[legacyName],batchCommands:counts[batchName],localLegacyMs:legacyMs,localBatchMs:batchMs,equivalentIndexes:true,uniqueConstraintEnforced:true,scope:'Disposable local comparison; timings do not measure Atlas network latency.'}));
}
main().catch(error=>{console.error('Index batching integration failed:',error.name);process.exitCode=1;}).finally(async()=>{
 if(connection?.readyState===1&&connection.name===legacyName&&/^cfh_index_legacy_[a-f0-9]{16}$/.test(legacyName)){
  if(batch?.name===batchName&&/^cfh_index_batch_[a-f0-9]{16}$/.test(batchName))await batch.db.dropDatabase();
  await connection.db.dropDatabase();
 }
 await connection?.close();
});
