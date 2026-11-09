#!/usr/bin/env node
'use strict';
// Disposable loopback-only proof of driver queue bounds and session-write cost.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto'),{promisify}=require('node:util');
const configured=new URL(process.env.MONGO_PLATFORM_URI||process.env.PLATFORM_DB_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Storage latency integration requires one unauthenticated loopback replica set');
const database='cfh_storage_latency_'+crypto.randomBytes(8).toString('hex');configured.pathname='/'+database;
const {MongoClient}=require('mongoose').mongo;
const {options}=require('../src/config/mongoOptions'),{createSessionStore}=require('../src/config/sessionStore'),{verifyReplicaPrimary}=require('../src/config/mongoTopology');
const driverOptions=options({NODE_ENV:'test',MONGO_POOL_MAX:'1'});delete driverOptions.autoIndex;delete driverOptions.bufferCommands;
// A shorter test-only checkout budget keeps this isolated probe quick. The web
// default is asserted independently as5000ms in storage-runtime.test.js.
const client=new MongoClient(configured.toString(),{...driverOptions,waitQueueTimeoutMS:75,monitorCommands:true});
async function main(){
 await client.connect();verifyReplicaPrimary(await client.db().admin().command({hello:1}));
 const collection=client.db().collection('latency_probe');await collection.insertOne({probe:true});
 const aggregateStarted=new Promise(resolve=>{const listener=event=>{if(event.commandName==='aggregate'){client.removeListener('commandStarted',listener);resolve();}};client.on('commandStarted',listener);});
 const busy=collection.aggregate([{$project:{result:{$function:{body:'function(milliseconds){const end=Date.now()+milliseconds;while(Date.now()<end){}return true;}',args:[500],lang:'js'}}}}]).toArray();
 await aggregateStarted;let queuedError,checkoutMs;
 try{const began=Date.now();await assert.rejects(collection.findOne({probe:true}),error=>{queuedError=error.name;return error.name==='MongoWaitQueueTimeoutError';});checkoutMs=Date.now()-began;assert(checkoutMs<1000,'pool exhaustion must not wait behind the entire slow operation');}finally{await busy;}
 let sessionWrites=0;client.on('commandStarted',event=>{if(event.commandName==='update'&&event.command.update==='sessions')sessionWrites++;});
 const store=await createSessionStore({client,dbName:database}),call=name=>promisify(store[name].bind(store));
 await call('set')('isolated-session',{identityId:'synthetic-identity',authVersion:0,cookie:{expires:new Date(Date.now()+1800000)}});
 for(let i=0;i<10;i++){const session=await call('get')('isolated-session');await call('touch')('isolated-session',session);}
 assert.equal(sessionWrites,1,'ten unchanged page reads should not write ten session touches');
 const session=await call('get')('isolated-session');session.authVersion=1;await call('set')('isolated-session',session);assert.equal(sessionWrites,2);assert.equal((await call('get')('isolated-session')).authVersion,1);
 await call('destroy')('isolated-session');assert.equal(await call('get')('isolated-session'),null);
 const ttl=await client.db().collection('sessions').listIndexes().toArray();assert(ttl.some(index=>index.key.expires===1&&index.expireAfterSeconds===0));
 console.log(JSON.stringify({event:'storage.latency_probe',queueError:queuedError,checkoutMs,unchangedPageReads:10,initialSessionWrites:1,totalSessionWritesAfterExplicitSave:sessionWrites,logoutImmediate:true,ttlIndexVerified:true,scope:'disposable-loopback-only'}));
}
main().catch(error=>{console.error('Storage latency integration failed:',error.name);process.exitCode=1;}).finally(async()=>{try{if(/^cfh_storage_latency_[a-f0-9]{16}$/.test(database))await client.db(database).dropDatabase();}finally{await client.close();}});
