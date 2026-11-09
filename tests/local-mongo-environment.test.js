'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const alias='mongodb://127.0.0.1:27019/synthetic_platform?replicaSet=rs0';
const base='mongodb://127.0.0.1:27019/?replicaSet=rs0';

function dotenvWorker(settings,explicit={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cfh-worker-env-'));
 try{
  fs.writeFileSync(path.join(directory,'.env'),Object.entries(settings).map(([key,value])=>`${key}=${value}`).join('\n'),{mode:0o600});
  const code=`try{const selected=require(${JSON.stringify(path.join(root,'src/config/workerMongo'))}).workerUri();process.stdout.write(JSON.stringify({selected}));}catch(error){process.stdout.write(JSON.stringify({error:error.message}));}`;
  const childEnv={...process.env,NODE_ENV:'development'};
  // Retain Windows process essentials while isolating application configuration.
  for(const key of ['MONGO_PLATFORM_URI','PLATFORM_DB_URI','MONGO_URI_BASE','MONGO_WORKER_URI','SESSION_SECRET','MFA_ENCRYPTION_KEY','APP_URL','TRUST_PROXY'])delete childEnv[key];
  Object.assign(childEnv,explicit);
  const child=spawnSync(process.execPath,['-e',code],{cwd:directory,env:childEnv,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  return JSON.parse(child.stdout);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}

test('standalone outbox reads alias-only .env while retaining explicit worker precedence and production separation',()=>{
 assert.equal(dotenvWorker({PLATFORM_DB_URI:alias,MONGO_URI_BASE:base}).selected,alias);
 const worker='mongodb://127.0.0.1:27020/synthetic_platform?replicaSet=rs0';
 assert.equal(dotenvWorker({MONGO_WORKER_URI:alias},{MONGO_WORKER_URI:worker}).selected,worker);
 assert.match(dotenvWorker({PLATFORM_DB_URI:alias,MONGO_URI_BASE:base},{NODE_ENV:'production'}).error,/least-privilege MONGO_WORKER_URI/);
 assert.equal(dotenvWorker({MONGO_WORKER_URI:worker},{NODE_ENV:'production'}).selected,worker,'worker-only startup must not require web session/MFA keys');
});

test('dev:local selects only its Docker database despite inherited platform/base settings',()=>{
 const env={NODE_ENV:'development',MFA_ENCRYPTION_KEY:'a'.repeat(64)};let captured,starts=0;
 vm.runInNewContext(fs.readFileSync(path.join(root,'scripts/dev-local.js'),'utf8'),{
  __dirname:path.join(root,'scripts'),process:{env,execPath:process.execPath},console:{log(){},error(){}},
  require(name){
   if(name==='dotenv')return{config(){Object.assign(env,{PLATFORM_DB_URI:alias,MONGO_PLATFORM_URI:alias,MONGO_URI_BASE:base});}};
   if(name==='./db-local')return{run(){starts++;}};
   if(name==='child_process')return{spawnSync(command,args,options){captured=options.env;return{status:0};}};
   return require(name);
  }
 });
 assert.equal(starts,1);assert(captured);
 assert.equal(captured.MONGO_PLATFORM_URI,'');assert.equal(captured.MONGO_URI_BASE,'');
 assert.equal(captured.PLATFORM_DB_URI,'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
 assert.equal(require('../src/config/mongoUris').resolveMongoConfiguration(captured).mongoPlatformUri,captured.PLATFORM_DB_URI);
 assert.equal(env.PLATFORM_DB_URI,alias,'the parent configuration must not be rewritten');
 assert.equal(env.MONGO_URI_BASE,base);
});

test('outbox doctor loads its worker-only .env before choosing a connector',async()=>{
 const env={};let workerConnections=0,webConnectorRequired=false;
 await vm.runInNewContext(fs.readFileSync(path.join(root,'scripts/outbox-doctor.js'),'utf8'),{
  process:{env},console:{log(){},error(){}},
  require(name){
   if(name==='dotenv')return{config(){env.MONGO_WORKER_URI=alias;}};
   if(name==='mongoose')return{disconnect:async()=>{}};
   if(name==='../src/config/workerMongo')return{connectWorkerMongo:async()=>{workerConnections++;throw new Error('Stop before database access');}};
   if(name==='../src/config/mongo'){webConnectorRequired=true;throw new Error('Web-only validation must not load');}
   if(name==='../src/config/mongoTopology')return{verifyReplicaPrimary(){}};
   return{};
  }
 });
 assert.equal(workerConnections,1);assert.equal(webConnectorRequired,false);
});
