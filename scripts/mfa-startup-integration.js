#!/usr/bin/env node
'use strict';
// Launches the real server from private temporary .env files. All accounts,
// sessions, encryption keys and databases are disposable local test fixtures.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises');
const path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const mongoose=require('mongoose'),bcrypt=require('bcryptjs');
const root=path.resolve(__dirname,'..'),serverFile=path.join(root,'src/server.js');
const selected=new URL(process.env.MONGO_PLATFORM_URI||process.env.PLATFORM_DB_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||selected.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(selected.hostname)||selected.host.includes(',')||selected.username||selected.password)throw Error('MFA startup integration requires an unauthenticated loopback MongoDB replica set');
const nonce=crypto.randomBytes(8).toString('hex'),platformName='cfh_mfa_startup_'+nonce,slug='mfa-startup-'+nonce;
selected.pathname='/'+platformName;
const syntheticKey=crypto.randomBytes(32).toString('hex'),sessionKey=crypto.randomBytes(48).toString('hex');
process.env.MFA_ENCRYPTION_KEY=syntheticKey;
const Tenant=require('../src/platform/models/Tenant'),Admin=require('../src/platform/models/PlatformAdmin'),Identity=require('../src/platform/models/AccountIdentity');
const core=require('../src/tenant/models'),mfa=require('../src/platform/services/mfa.service');
const commerce=require('../src/platform/services/commercial.service'),{tenantDbNameFromSlug}=require('../src/config/tenantDatabaseName');
const children=new Set(),accounts=[];let temporary,tenantConnection;
const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
function csrf(html){const match=html.match(/name="_csrf" value="([a-f0-9]{64})"/);assert(match,'Expected protected login form');return match[1];}
function cookie(response,previous){const values=response.headers.getSetCookie?.()||[response.headers.get('set-cookie')||''];return values.find(value=>value.startsWith('cfh.sid='))?.split(';')[0]||previous;}
async function request(url,options={}){return fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(5000)});}
async function unusedPort(){const listener=net.createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));return port;}
function childEnvironment(){const result={};for(const name of ['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','TEMP','TMP','LANG','TZ','NODE_EXTRA_CA_CERTS'])if(process.env[name])result[name]=process.env[name];return result;}
async function launch(fixture,index){
 const directory=path.join(temporary,'case-'+index);await fs.mkdir(directory,{mode:0o700});
 const port=await unusedPort(),base='http://127.0.0.1:'+port;
 const entries=[`PORT=${port}`,`APP_URL=${base}`,`MONGO_PLATFORM_URI=${selected.toString()}`,`SESSION_SECRET=${sessionKey}`,`MFA_ENCRYPTION_KEY=${syntheticKey}`,
  'TRANSFER_SMS_PROVIDER=none','TENANT_BACKUPS_ENABLED=false',...(fixture.nodeEnv?[`NODE_ENV=${fixture.nodeEnv}`]:[]),...(fixture.fileFlag===undefined?[]:[`MFA_ENABLED=${JSON.stringify(fixture.fileFlag)}`])];
 await fs.writeFile(path.join(directory,'.env'),entries.join('\n')+'\n',{mode:0o600});
 const child=spawn(process.execPath,[serverFile],{cwd:directory,env:{...childEnvironment(),...(fixture.processFlag===undefined?{}:{MFA_ENABLED:fixture.processFlag})},stdio:['ignore','pipe','pipe']});
 let exited=false,exitCode,spawnFailed=false;
 const finished=new Promise(resolve=>{child.once('error',()=>{spawnFailed=true;exited=true;resolve();});child.once('exit',code=>{exited=true;exitCode=code;resolve();});});
 // Consume output without echoing configuration, passwords or enrollment HTML.
 child.stdout.resume();child.stderr.resume();
 const handle={base,async stop(expectClean=false){
  let forced=false;
  if(!exited){child.kill('SIGTERM');const timeout=setTimeout(()=>{forced=true;child.kill('SIGKILL');},12000);try{await finished;}finally{clearTimeout(timeout);}}
  children.delete(handle);if(expectClean){assert.equal(forced,false,'Server shutdown should drain normally');assert.equal(exitCode,0,'Server should exit cleanly');}
 }};children.add(handle);
 for(let attempt=0;attempt<200;attempt++){
  if(exited)throw Error('Server failed to start for '+fixture.name+(spawnFailed?' (spawn failure)':' (exit '+exitCode+')'));
  try{const ready=await request(base+'/health/ready');if(ready.status===200)return handle;}catch{}
  await pause(100);
 }
 throw Error('Server readiness timed out for '+fixture.name);
}
async function signIn(base,account,password){
 const page=await request(base+'/signin');assert.equal(page.status,200);
 let sessionCookie=cookie(page);assert(sessionCookie,'Login page must create a session');
 const response=await request(base+'/signin',{method:'POST',headers:{cookie:sessionCookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf(await page.text()),email:account.email,password}).toString()});
 sessionCookie=cookie(response,sessionCookie);return{response,cookie:sessionCookie};
}
async function unchangedEnrollment(){for(const account of accounts){const current=await account.Model.findById(account.id).select('+mfaSecretEncrypted').lean();assert.equal(current.mfaSecretEncrypted,account.encrypted);assert.equal(current.mfaEnabledAt?.toISOString()||null,account.enrolledAt);assert.equal(current.authVersion,0);assert.equal(current.mfaLastCounter,-1);}}
async function policyCases(){
 for(const fixture of [
  {name:'production missing',nodeEnv:'production',expected:{enabled:true,mode:'enabled',source:'production_default'}},
  {name:'production blank',nodeEnv:'production',flag:'  ',expected:{enabled:true,mode:'enabled',source:'production_default'}},
  {name:'production explicit false',nodeEnv:'production',flag:'  FaLsE  ',expected:{enabled:false,mode:'disabled',source:'explicit'}},
  {name:'invalid value',nodeEnv:'development',flag:'not-a-boolean',expected:{enabled:true,mode:'enabled',source:'invalid_value'}}
 ]){
  const result=spawnSync(process.execPath,['-e',`process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(root,'src/config/mfaPolicy.js'))}).status()))`],{cwd:temporary,env:{...childEnvironment(),NODE_ENV:fixture.nodeEnv,...(fixture.flag===undefined?{}:{MFA_ENABLED:fixture.flag})},encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,fixture.name+' policy child failed');assert.deepEqual(JSON.parse(result.stdout),fixture.expected,fixture.name);
 }
}
async function main(){
 temporary=await fs.mkdtemp(path.join(os.tmpdir(),'cfh-mfa-startup-'));await fs.chmod(temporary,0o700);
 await policyCases();
 mongoose.set('strictQuery',true);await mongoose.connect(selected.toString(),{autoIndex:false,serverSelectionTimeoutMS:7000,maxPoolSize:5});
 require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Tenant.createIndexes(),Admin.createIndexes(),Identity.createIndexes()]);
 const modules=['money_transfer'],terms=commerce.planSnapshot({...commerce.asPlanVersion({...require('../src/data/store').plans.find(plan=>plan.code==='enterprise'),modules}),status:'published'});
 const tenant=await Tenant.create({name:'Startup policy scratch tenant',slug,dbName:tenantDbNameFromSlug(slug),owner:'Scratch owner',email:'owner-'+nonce+'@example.invalid',plan:terms.planCode,status:'active',setupStatus:'complete',enabledModules:modules,seatsReserved:2,branchCount:0,
  subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 tenantConnection=mongoose.connection.useDb(tenant.dbName,{useCache:true});await core.ensureTenantIndexes(tenantConnection);
 const password='Startup-Integration-'+crypto.randomBytes(16).toString('hex')+'#9a',passwordHash=await bcrypt.hash(password,10);
 for(const kind of ['platform','tenant'])for(const enrolled of [false,true]){
  const Model=kind==='platform'?Admin:core.tenantUserModel(tenantConnection),email=kind+'-'+(enrolled?'enrolled':'fresh')+'-'+nonce+'@example.invalid';
  const encrypted=enrolled?mfa.encryptSecret(mfa.generateSecret()):null,enrolledAt=enrolled?new Date():null;
  const row=await Model.create({name:'Startup policy scratch account',email,passwordHash,role:kind==='platform'?'Super Admin':'Tenant Owner',status:'active',authVersion:0,mfaLastCounter:-1,mfaSecretEncrypted:encrypted,mfaEnabledAt:enrolledAt,...(kind==='tenant'?{allowedModules:modules}:{})});
  const identity=await Identity.create({email,kind,accountId:row._id,...(kind==='tenant'?{tenantId:tenant._id}:{})});
  accounts.push({kind,enrolled,Model,email,id:row._id,identityId:String(identity._id),encrypted,enrolledAt:enrolledAt?.toISOString()||null,dashboard:kind==='platform'?'/platform/dashboard':'/tenant/dashboard'});
 }
 const fixtures=[
  {name:'development missing flag',enabled:false},
  {name:'development blank flag',nodeEnv:'development',fileFlag:'',enabled:false},
  {name:'development mixed-case .env false',nodeEnv:'development',fileFlag:'  fAlSe  ',enabled:false},
  {name:'process true overrides .env false',nodeEnv:'development',fileFlag:'false',processFlag:'  TrUe  ',enabled:true},
  {name:'disabled after MFA startup',nodeEnv:'development',fileFlag:'false',enabled:false}
 ];
 const pendingCookies=[];let ordinaryCookie;
 for(const [index,fixture]of fixtures.entries()){
  const server=await launch(fixture,index);
  try{
   if(fixture.enabled&&ordinaryCookie){const stale=await request(server.base+accounts[0].dashboard,{headers:{cookie:ordinaryCookie}});assert([303,401].includes(stale.status),'A password-only session cannot become MFA verified after restart');}
   if(index===fixtures.length-1)for(const stale of pendingCookies){
    const response=await request(server.base+'/mfa/'+(stale.enrolled?'challenge':'setup'),{headers:{cookie:stale.cookie}});assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/signin');
    const denied=await request(server.base+stale.dashboard,{headers:{cookie:stale.cookie}});assert.equal(denied.status,303,'A stale pending MFA session still needs a fresh password login');
   }
   for(const account of accounts){
    const signed=await signIn(server.base,account,password);assert.equal(signed.response.status,303,fixture.name+' password response');
    const expected=fixture.enabled?'/mfa/'+(account.enrolled?'challenge':'setup'):account.dashboard;
    assert.equal(signed.response.headers.get('location'),expected,fixture.name+' '+account.kind+' redirect');
    const page=await request(server.base+expected,{headers:{cookie:signed.cookie}});assert.equal(page.status,200,fixture.name+' destination');
    if(fixture.enabled){pendingCookies.push({...account,cookie:signed.cookie});continue;}
    const sessions=await mongoose.connection.db.collection('sessions').find({}).toArray();
    const ordinary=sessions.map(row=>JSON.parse(row.session)).find(row=>String(row.identityId)===account.identityId&&row.authenticatedAt);
    assert(ordinary,'Password login should create an ordinary authenticated session');assert.equal(ordinary.mfaVerifiedAt,undefined);assert.equal(ordinary.pendingMfa,undefined);
    for(const route of ['/mfa/setup','/mfa/challenge']){const stale=await request(server.base+route,{headers:{cookie:signed.cookie}});assert.equal(stale.status,303);assert.equal(stale.headers.get('location'),'/signin');}
    assert.equal((await request(server.base+account.dashboard,{headers:{cookie:signed.cookie}})).status,200,'Visiting an old MFA URL must not destroy an ordinary authenticated session');
    if(account===accounts[0])ordinaryCookie=signed.cookie;
   }
   await unchangedEnrollment();
  }finally{await server.stop(true);}
 }
 console.log('PASS: real server startup honors development missing/blank/.env false, explicit process true precedence, production secure defaults, password login redirects, stale MFA URLs, unchanged enrollment and ordinary sessions');
}
main().catch(()=>{console.error('FAIL: MFA startup integration did not satisfy a local startup/authentication assertion');process.exitCode=1;}).finally(async()=>{
 for(const child of [...children])await child.stop();
 if(mongoose.connection.name===platformName&&platformName.startsWith('cfh_mfa_startup_')){if(tenantConnection)await tenantConnection.db.dropDatabase();await mongoose.connection.db.dropDatabase();}
 await mongoose.disconnect();if(temporary)await fs.rm(temporary,{recursive:true,force:true});
});
