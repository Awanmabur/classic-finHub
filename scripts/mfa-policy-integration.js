#!/usr/bin/env node
'use strict';
// Real login/session checks in disposable local databases. Never sends email or
// connects to a remote database, and never changes an existing enrollment/key.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const selected=new URL(process.env.MONGO_PLATFORM_URI||process.env.PLATFORM_DB_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||selected.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(selected.hostname)||selected.host.includes(',')||selected.username||selected.password)throw Error('MFA policy integration requires an isolated unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),platformName='cfh_mfa_policy_'+nonce,slug='mfa-policy-'+nonce;
selected.pathname='/'+platformName;process.env.MONGO_PLATFORM_URI=selected.toString();delete process.env.PLATFORM_DB_URI;delete process.env.MONGO_URI_BASE;
process.env.NODE_ENV='test';process.env.APP_URL='http://localhost:3000';process.env.MFA_ENABLED='false';
const retainedTestKey=crypto.randomBytes(32).toString('hex');delete process.env.MFA_ENCRYPTION_KEY;
process.env.TRANSFER_SMS_PROVIDER='none';process.env.TENANT_BACKUPS_ENABLED='false';
const mongoose=require('mongoose'),bcrypt=require('bcryptjs'),session=require('express-session');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo'),core=require('../src/tenant/models');
const Tenant=require('../src/platform/models/Tenant'),Admin=require('../src/platform/models/PlatformAdmin'),Identity=require('../src/platform/models/AccountIdentity');
const mfa=require('../src/platform/services/mfa.service'),commerce=require('../src/platform/services/commercial.service');
let conn,server;const store=new session.MemoryStore();
const csrf=html=>{const found=html.match(/name="_csrf" value="([a-f0-9]{64})"/);assert(found,'CSRF token required');return found[1];};
const sessions=()=>new Promise((resolve,reject)=>store.all((error,values)=>error?reject(error):resolve(Object.values(values))));
async function main(){
 await connectPlatformMongo();await Promise.all([Tenant.createIndexes(),Admin.createIndexes(),Identity.createIndexes()]);
 conn=getTenantConnection(slug);await core.ensureTenantIndexes(conn);
 const plan={...commerce.asPlanVersion(require('../src/data/store').plans.find(row=>row.code==='enterprise')),status:'published'},terms=commerce.planSnapshot(plan);
 const tenant=await Tenant.create({name:'MFA policy probe',slug,dbName:conn.name,owner:'Probe owner',email:`owner-${nonce}@example.invalid`,plan:plan.code,status:'active',setupStatus:'complete',enabledModules:terms.modules,seatsReserved:1,branchCount:0,
  subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-1000),periodEnd:new Date(Date.now()+86400000)}});
 const password='MFA-Policy-Integration#'+nonce,passwordHash=await bcrypt.hash(password,10),accounts=[];
 for(const kind of ['platform','tenant']){
  const Model=kind==='platform'?Admin:core.tenantUserModel(conn),email=`${kind}-${nonce}@example.invalid`;
  const row=await Model.create({name:'MFA policy probe',email,passwordHash,role:kind==='platform'?'Super Admin':'Tenant Owner',status:'active',...(kind==='tenant'?{allowedModules:terms.modules}:{})});
  const identity=await Identity.create({email,kind,accountId:row._id,...(kind==='tenant'?{tenantId:tenant._id}:{})});accounts.push({kind,Model,row,identity});
 }
 server=await new Promise(resolve=>{const instance=require('../src/app')({sessionStore:store}).listen(0,()=>resolve(instance));});const base='http://127.0.0.1:'+server.address().port;
 async function login(account,enteredPassword=password){const initial=await fetch(base+'/signin');let cookie=initial.headers.get('set-cookie').split(';')[0];const token=csrf(await initial.text());
  const result=await fetch(base+'/signin',{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:token,email:account.row.email,password:enteredPassword}).toString()});
  cookie=result.headers.get('set-cookie')?.split(';')[0]||cookie;return{result,cookie};}
 for(const account of accounts){
  const wrong=await login(account,'Incorrect-Password#1');assert.equal(wrong.result.headers.get('location'),'/signin');
  const signed=await login(account),dashboard=account.kind==='platform'?'/platform/dashboard':'/tenant/dashboard';
  assert.equal(signed.result.status,303);assert.equal(signed.result.headers.get('location'),dashboard);
  assert.equal((await fetch(base+dashboard,{headers:{cookie:signed.cookie},redirect:'manual'})).status,200);
  const persisted=(await sessions()).find(value=>String(value.identityId)===String(account.identity._id)&&value.authenticatedAt);
  assert(persisted);assert.equal(persisted.mfaVerifiedAt,undefined);assert.equal(persisted.pendingMfa,undefined);
  assert.equal((await account.Model.findById(account.row._id).lean()).mfaEnabledAt,null);
  account.offCookie=signed.cookie;
 }
 assert.equal(process.env.MFA_ENCRYPTION_KEY,undefined,'password-only access must not need a TOTP encryption key');
 assert.equal((await fetch(base+'/tenant/dashboard',{headers:{cookie:accounts[0].offCookie},redirect:'manual'})).status,303);
 assert.equal((await fetch(base+'/platform/dashboard',{headers:{cookie:accounts[1].offCookie},redirect:'manual'})).status,303);
 const csrfPage=await fetch(base+'/platform/dashboard',{headers:{cookie:accounts[0].offCookie}});assert.equal(csrfPage.status,200);
 assert.equal((await fetch(base+'/platform/tenants',{method:'POST',redirect:'manual',headers:{cookie:accounts[0].offCookie,'content-type':'application/x-www-form-urlencoded'},body:'name=Missing-CSRF'})).status,403);
 process.env.MFA_ENCRYPTION_KEY=retainedTestKey;process.env.MFA_ENABLED='true';
 for(const account of accounts){
  const dashboard=account.kind==='platform'?'/platform/dashboard':'/tenant/dashboard';
  const stale=await fetch(base+dashboard,{headers:{cookie:account.offCookie},redirect:'manual'});assert([303,401].includes(stale.status),'password-only sessions must fail after MFA is re-enabled');
  const signed=await login(account);assert.equal(signed.result.headers.get('location'),'/mfa/setup');
  const setup=await fetch(base+'/mfa/setup',{headers:{cookie:signed.cookie},redirect:'manual'});assert.equal(setup.status,200);const html=await setup.text(),secret=html.match(/<strong>([A-Z2-7]{32})<\/strong>/)?.[1];assert(secret,'real enrollment secret is required');
  const verified=await fetch(base+'/mfa/setup',{method:'POST',redirect:'manual',headers:{cookie:signed.cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf(html),code:mfa.counterCode(secret,Math.floor(Date.now()/30000))}).toString()});
  assert.equal(verified.status,303);assert.equal(verified.headers.get('location'),dashboard);
  const cookie=verified.headers.get('set-cookie')?.split(';')[0]||signed.cookie;
  assert.equal((await fetch(base+dashboard,{headers:{cookie},redirect:'manual'})).status,200);
  const genuine=(await sessions()).find(value=>String(value.identityId)===String(account.identity._id)&&value.mfaVerifiedAt);assert(genuine);
  const enrolled=await account.Model.findById(account.row._id).select('+mfaSecretEncrypted').lean();assert(enrolled.mfaEnabledAt);assert(enrolled.mfaSecretEncrypted);
  const repeat=await login(account);assert.equal(repeat.result.headers.get('location'),'/mfa/challenge','enrolled accounts must resume real MFA challenges');
 }
 process.env.MFA_ENABLED='false';delete process.env.MFA_ENCRYPTION_KEY;
 for(const account of accounts){
  const before=await account.Model.findById(account.row._id).select('+mfaSecretEncrypted').lean();
  const signed=await login(account),dashboard=account.kind==='platform'?'/platform/dashboard':'/tenant/dashboard';
  assert.equal(signed.result.headers.get('location'),dashboard);
  assert.equal((await fetch(base+dashboard,{headers:{cookie:signed.cookie},redirect:'manual'})).status,200);
  const after=await account.Model.findById(account.row._id).select('+mfaSecretEncrypted').lean();
  assert.equal(after.mfaSecretEncrypted,before.mfaSecretEncrypted);assert.equal(after.authVersion,before.authVersion);assert.equal(after.mfaLastCounter,before.mfaLastCounter);
  assert.equal(new Date(after.mfaEnabledAt).getTime(),new Date(before.mfaEnabledAt).getTime());
  assert((await sessions()).some(value=>String(value.identityId)===String(account.identity._id)&&value.authVersion===after.authVersion&&value.authenticatedAt&&!value.mfaVerifiedAt));
  account.offCookie=signed.cookie;
 }
 process.env.MFA_ENCRYPTION_KEY=retainedTestKey;process.env.MFA_ENABLED='true';
 for(const account of accounts){
  const dashboard=account.kind==='platform'?'/platform/dashboard':'/tenant/dashboard';
  assert([303,401].includes((await fetch(base+dashboard,{headers:{cookie:account.offCookie},redirect:'manual'})).status));
  assert.equal((await login(account)).result.headers.get('location'),'/mfa/challenge');
 }
 console.log('PASS: optional MFA permits real password login without fake verification, preserves enrollment, retains CSRF/identity/version gates, and re-enabled MFA rejects old sessions and requires genuine enrollment/challenge for platform and tenant accounts');
}
main().catch(error=>{console.error('MFA policy integration failed:',error.stack||error.message);process.exitCode=1;}).finally(async()=>{
 if(server)await new Promise(resolve=>server.close(resolve));
 if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_mfa_policy_[a-f0-9]{16}$/.test(platformName)){if(conn)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}
 await mongoose.disconnect();
});
