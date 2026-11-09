'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {promisify}=require('node:util');
const express=require('express');
const {EventEmitter}=require('node:events');
const {options}=require('../src/config/mongoOptions');
const storage=require('../src/config/storageErrors');
const {createSessionStore}=require('../src/config/sessionStore');

test('Mongo connection acquisition is bounded without a whole-mutation client deadline',()=>{
 const value=options({NODE_ENV:'production'});
 assert.equal(value.maxPoolSize,30);assert.equal(value.waitQueueTimeoutMS,5000);assert.equal(value.connectTimeoutMS,7000);
 assert.equal(value.serverSelectionTimeoutMS,7000);assert.equal(value.socketTimeoutMS,30000);assert.equal(value.bufferCommands,false);
 assert.equal(value.autoIndex,false);assert.equal(value.timeoutMS,undefined);assert.equal(value.retryWrites,true);
 for(const MONGO_POOL_MAX of ['0','-1','201','NaN','30.5',''])assert.throws(()=>options({MONGO_POOL_MAX}),/integer from 1 to 200/);
 assert.equal(options({MONGO_POOL_MAX:'4'}).maxPoolSize,4);
});

test('only recognized database outages map to a bounded retryable response',()=>{
 for(const name of ['MongoNetworkError','MongoNetworkTimeoutError','MongoServerSelectionError','MongooseServerSelectionError','MongoWaitQueueTimeoutError','MongoPoolClearedError','MongoNotConnectedError'])assert(storage.unavailable({name}));
 assert(storage.unavailable({name:'MongooseError',message:'Cannot call find before initial connection if bufferCommands = false.'}));
 assert(storage.unavailable({name:'Error',code:'STORAGE_UNAVAILABLE'}));
 assert(storage.unavailable({name:'MongoServerError',code:91}));
 for(const error of [{name:'MongoServerError',code:13},{name:'MongoServerError',code:11000},{name:'ValidationError'},{name:'Error',code:'ETIMEDOUT'},{name:'Error',message:'Database uri secret'}])assert.equal(storage.unavailable(error),false);
});

test('a disconnected logical tenant handle returns the same known 503 storage code',()=>{
 const {getTenantConnection}=require('../src/config/mongo');
 assert.throws(()=>getTenantConnection('disconnected-test'),error=>error.status===503&&error.code==='STORAGE_UNAVAILABLE'&&storage.unavailable(error));
});

test('database outages return safe 503 without killing later requests or leaking driver details',async t=>{
 const logs=[];t.mock.method(console,'error',line=>logs.push(line));
 const app=express();app.get('/fail',(_req,_res,next)=>next(Object.assign(new Error('private database credentials and query'),{name:'MongoWaitQueueTimeoutError'})));app.get('/ready',(_req,res)=>res.sendStatus(200));app.use(require('../src/middleware/errorHandler'));
 const server=await new Promise(resolve=>{const listener=app.listen(0,()=>resolve(listener));});
 try{
  const base='http://127.0.0.1:'+server.address().port,response=await fetch(base+'/fail');
  assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'5');assert.match(await response.text(),/operation history/);
  assert.equal((await fetch(base+'/ready')).status,200);assert.doesNotMatch(logs.join('\n'),/credentials|private database|and query/);
  assert.equal(JSON.parse(logs[0]).reason,'storage_unavailable');
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('disconnected models fail promptly instead of buffering a request for ten seconds',async()=>{
 const mongoose=require('mongoose'),isolated=new mongoose.Mongoose();
 const Model=isolated.model('DisconnectedProbe',new isolated.Schema({name:String},{bufferCommands:false,autoIndex:false,autoCreate:false}));
 const began=Date.now();await assert.rejects(Model.findOne({name:'probe'}),error=>storage.unavailable(error));
 assert(Date.now()-began<500,'the disconnected read must not enter the default 10s buffer');
});

test('session TTL setup finishes before constructing its store and readiness rejection is observed',async()=>{
 let resolveIndex,constructed=0,observed;
 const index=new Promise(resolve=>{resolveIndex=resolve;});
 const client={db(){return{collection(){return{createIndex(keys,opts){assert.deepEqual(keys,{expires:1});assert.equal(opts.expireAfterSeconds,0);return index;}};}};}};
 const Store={create(opts){constructed++;observed=opts;const store=new EventEmitter();store.collectionP=Promise.resolve({});return store;}};
 const pending=createSessionStore({client,dbName:'platform',Store});assert.equal(constructed,0);resolveIndex();await pending;
 assert.equal(constructed,1);assert.equal(observed.autoRemove,'disabled');assert.equal(observed.touchAfter,60);
 let afterFailure=0;const broken={db(){return{collection(){return{createIndex:async()=>{throw Error('index unavailable');}};}};}};
 await assert.rejects(createSessionStore({client:broken,dbName:'platform',Store:{create(){afterFailure++;}}}),/index unavailable/);assert.equal(afterFailure,0);
 const failedStore=new EventEmitter();failedStore.collectionP=Promise.reject(Error('collection unavailable'));
 await assert.rejects(createSessionStore({client,dbName:'platform',Store:{create:()=>failedStore}}),/collection unavailable/);
});

test('real session store coalesces read touches while writes and logout persist immediately',async()=>{
 let row=null,writes=0,deletes=0,indexes=0;const logs=[];
 const collection={
  createIndex:async()=>{indexes++;},
  async updateOne(filter,update){writes++;const fresh=!row;row={...row,...structuredClone(update.$set)};return{matchedCount:fresh?0:1,upsertedCount:fresh?1:0};},
  async findOne(){return row&&structuredClone(row);},
  async deleteOne(){deletes++;row=null;return{deletedCount:1};}
 };
 const client={db(){return{collection(){return collection;}};}},store=await createSessionStore({client,dbName:'platform',log:line=>logs.push(line)});
 const call=name=>promisify(store[name].bind(store));
 await call('set')('session-one',{identityId:'identity-one',authVersion:0,cookie:{expires:new Date(Date.now()+1800000)}});
 assert.equal(writes,1);const session=await call('get')('session-one');await call('touch')('session-one',session);await call('touch')('session-one',session);assert.equal(writes,1,'ordinary page reads share the one-minute touch window');
 session.authVersion=1;await call('set')('session-one',session);assert.equal(writes,2);assert.equal((await call('get')('session-one')).authVersion,1);
 await call('destroy')('session-one');assert.equal(deletes,1);assert.equal(await call('get')('session-one'),null);assert.equal(indexes,1);
 store.emit('error',Object.assign(Error('private session payload'),{name:'MongoNetworkError'}));assert.deepEqual(logs,[{event:'session.storage_error',code:'STORAGE_UNAVAILABLE'}]);
});
