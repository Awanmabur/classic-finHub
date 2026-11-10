#!/usr/bin/env node
'use strict';
// Counts real MongoDB commands for isolated, authenticated HTTP requests. The
// optional delay models a round trip before each Mongoose query/aggregation; an
// illustrative scheduling probe, not a measurement of any Atlas deployment.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs');
const configured=new URL(require('../src/config/mongoUris').resolveMongoConfiguration(process.env).mongoPlatformUri);
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Workspace latency integration requires an unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),scratch='cfh_workspace_latency_'+nonce,slug='workspace-latency-'+nonce;
configured.pathname='/'+scratch;
Object.assign(process.env,{NODE_ENV:'test',MFA_ENABLED:'false',MONGO_PLATFORM_URI:configured.toString(),PLATFORM_DB_URI:'',MONGO_URI_BASE:'',APP_URL:'http://localhost:3000',RESEND_API_KEY:'',MAIL_FROM:'',TRANSFER_SMS_PROVIDER:'none',TENANT_BACKUPS_ENABLED:'false'});
const delayMs=Number(process.env.WORKSPACE_QUERY_DELAY_MS||0);assert(Number.isInteger(delayMs)&&delayMs>=0&&delayMs<=500);
const mongoose=require('mongoose'),bcrypt=require('bcryptjs'),mongo=require('../src/config/mongo'),core=require('../src/tenant/models');
const Tenant=require('../src/platform/models/Tenant'),Identity=require('../src/platform/models/AccountIdentity'),Admin=require('../src/platform/models/PlatformAdmin'),commerce=require('../src/platform/services/commercial.service');
let server,conn,sessionStore,measured,delaying=false;const result={queryDelayMs:delayMs,scope:'disposable-loopback-only',requests:[]};
const csrf=html=>{const match=html.match(/name="_csrf" value="([a-f0-9]{64})"/);assert(match,'CSRF token must be rendered');return match[1];};
const queryExec=mongoose.Query.prototype.exec,aggregateExec=mongoose.Aggregate.prototype.exec;
mongoose.Query.prototype.exec=async function(...args){if(delaying&&delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));return queryExec.apply(this,args);};
mongoose.Aggregate.prototype.exec=async function(...args){if(delaying&&delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));return aggregateExec.apply(this,args);};
async function main(){
 await mongoose.connect(configured.toString(),{...require('../src/config/mongoOptions').options(process.env),autoIndex:false,autoCreate:false,monitorCommands:true});
 require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),Identity.createIndexes(),Admin.createIndexes(),...['LoginThrottle','SecurityEvent','PasswordReset','PlanVersion','PlanDraft','PlanPublicationLock','SmsDevice','SmsUsage','UsageCounter','OutboxEvent','WorkerHeartbeat'].map(name=>require('../src/platform/models/'+name).createIndexes())]);
 const modules=require('../src/data/store').modules.filter(module=>module.runtimeStatus!=='disabled').map(module=>module.key).filter(key=>key!=='sms_capture');
 const version={...commerce.asPlanVersion({...require('../src/data/store').plans.find(plan=>plan.code==='enterprise'),code:'latency_probe',modules}),status:'published'},terms=commerce.planSnapshot(version);
 const tenant=await Tenant.create({name:'Latency Probe Workspace',slug,dbName:mongo.tenantDbNameFromSlug(slug),owner:'Owner',email:'owner-'+nonce+'@example.invalid',plan:version.code,status:'active',setupStatus:'complete',enabledModules:modules,seatsReserved:1,branchCount:2,subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-10000),periodEnd:new Date(Date.now()+86400000)}});
 conn=mongo.getTenantConnection(slug);
 await core.ensureTenantIndexes(conn);
 await Promise.all([require('../src/tenant/customerAccounts/models').ensureIndexes(conn),require('../src/tenant/models/expenses').ensureExpenseIndexes(conn),require('../src/tenant/workspace/models').ensure(conn),require('../src/tenant/treasury/models').ensure(conn),require('../src/tenant/treasury/funding.models').ensureIndexes(conn),require('../src/tenant/funded/models').ensureIndexes(conn)]);
 const ownerId=new mongoose.Types.ObjectId();
 const branch=await core.branchModel(conn).create({name:'Main Office',code:'main',currency:'UGX',currencies:['UGX','USD','SSP','KES'],createdBy:ownerId,updatedBy:ownerId});
 const destination=await core.branchModel(conn).create({name:'Receiving Office',code:'receiving',currency:'UGX',currencies:['UGX','USD','SSP','KES'],createdBy:ownerId,updatedBy:ownerId});
 const password='Latency-Probe-'+nonce+'#9a',passwordHash=await bcrypt.hash(password,10);
 const owner=await core.tenantUserModel(conn).create({_id:ownerId,name:'Latency Owner',email:tenant.email,passwordHash,role:'Tenant Owner',branchId:branch._id,allowedModules:modules,status:'active',authVersion:0});
 await Identity.create({email:owner.email,kind:'tenant',tenantId:tenant._id,accountId:owner._id});
 const admin=await Admin.create({name:'Latency Admin',email:'admin-'+nonce+'@example.invalid',passwordHash,role:'Super Admin',status:'active',authVersion:0});await Identity.create({email:admin.email,kind:'platform',accountId:admin._id});
 sessionStore=await require('../src/config/sessionStore').createSessionStore({client:mongoose.connection.getClient(),dbName:scratch});
 server=await new Promise(resolve=>{const listener=require('../src/app')({sessionStore}).listen(0,()=>resolve(listener));});const base='http://127.0.0.1:'+server.address().port;
 mongoose.connection.getClient().on('commandStarted',event=>{if(!measured||['hello','endSessions'].includes(event.commandName))return;const collection=typeof event.command[event.commandName]==='string'?event.command[event.commandName]:'';measured.commands.push({name:event.commandName,collection});});
 async function request(path,{cookie='',body,measure=false}={}){
  if(measure){measured={path,method:body?'POST':'GET',commands:[]};delaying=true;}
  const began=performance.now();
  try{const response=await fetch(base+path,{method:body?'POST':'GET',redirect:'manual',headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},...(body?{body:new URLSearchParams(body)}:{}),signal:AbortSignal.timeout(30000)});const html=await response.text();if(measure){measured.status=response.status;measured.durationMs=Math.round(performance.now()-began);measured.commandCount=measured.commands.length;result.requests.push(measured);}return{response,html,cookie:response.headers.get('set-cookie')?.split(';')[0]||cookie};}
  finally{measured=null;delaying=false;}
 }
 async function login(row){const signin=await request('/signin');const signed=await request('/signin',{cookie:signin.cookie,body:{_csrf:csrf(signin.html),email:row.email,password},measure:true});assert.equal(signed.response.status,303);assert.equal(signed.response.headers.get('location'),row===admin?'/platform/dashboard':'/tenant/dashboard');return signed.cookie;}
 const ownerCookie=await login(owner);
 const paths=['/tenant/dashboard','/tenant/branches','/tenant/money-transfer/send?currency=UGX','/tenant/mobile-money'];
 for(const path of paths){const warm=await request(path,{cookie:ownerCookie});assert.equal(warm.response.status,200,path+' warm-up');const response=await request(path,{cookie:ownerCookie,measure:true});assert.equal(response.response.status,200,path);}
 // Save a real request only: no collection, PIN release, payment or provider
 // action is performed. Repeating the same form keeps one accepted record.
 const send=await request('/tenant/money-transfer/send?currency=UGX',{cookie:ownerCookie});
 const idempotencyKey=crypto.randomUUID(),body={_csrf:csrf(send.html),idempotencyKey,senderName:'Latency Sender',senderPhone:'+211921234567',senderCountry:'SS',receiverName:'Latency Receiver',receiverPhone:'+211922345678',receiverCountry:'SS',destinationBranchId:String(destination._id),currency:'UGX',amount:'1',fee:'0',validDays:'7'};
 const posted=await request('/tenant/money-transfer/requests',{cookie:ownerCookie,body,measure:true});assert.equal(posted.response.status,303);
 assert.equal((await request('/tenant/money-transfer/requests',{cookie:ownerCookie,body,measure:true})).response.status,303);
 assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey,status:'requested'}),1);
 assert.equal(await core.ledgerJournalModel(conn).countDocuments(),0,'A pending transfer request must not post funds');
 result.transferRequest={acceptedOnce:true,pendingWithoutLedgerMovement:true};
 const adminCookie=await login(admin);await request('/platform/dashboard',{cookie:adminCookie});assert.equal((await request('/platform/dashboard',{cookie:adminCookie,measure:true})).response.status,200);
 if(process.env.WORKSPACE_LATENCY_OUTPUT)fs.writeFileSync(process.env.WORKSPACE_LATENCY_OUTPUT,JSON.stringify(result,null,2)+'\n');
 console.log('PASS '+JSON.stringify(result));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{
 delaying=false;mongoose.Query.prototype.exec=queryExec;mongoose.Aggregate.prototype.exec=aggregateExec;
 if(server)await new Promise(resolve=>server.close(resolve));
 if(mongoose.connection.name===scratch&&/^cfh_workspace_latency_[a-f0-9]{16}$/.test(scratch)){if(conn&&conn.name===mongo.tenantDbNameFromSlug(slug))await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}
 await mongoose.disconnect();
});
