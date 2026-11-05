#!/usr/bin/env node
'use strict';
// Full HTTP provisioning lifecycle in random, disposable loopback databases.
// Never targets a remote cluster or drops an existing application database.
require('dotenv').config();
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI || 'mongodb://127.0.0.1:27017/classicfin_platform_db');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||
  !['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password){
  throw Error('Tenant integration requires a single unauthenticated loopback replica set');
}
const nonce=crypto.randomBytes(8).toString('hex');
const scratchName=`cfh_provision_probe_${nonce}`;
configured.pathname=`/${scratchName}`;
process.env.MONGO_PLATFORM_URI=configured.toString();
process.env.NODE_ENV='test';
if(!process.env.MFA_ENCRYPTION_KEY)process.env.MFA_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');
const mongoose=require('mongoose');
const bcrypt=require('bcryptjs');
const session=require('express-session');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const Tenant=require('../src/platform/models/Tenant');
const Identity=require('../src/platform/models/AccountIdentity');
const Admin=require('../src/platform/models/PlatformAdmin');
const Invite=require('../src/platform/models/OwnerInvite');
const Audit=require('../src/platform/models/PlatformAuditLog');
const PlanVersion=require('../src/platform/models/PlanVersion');
const mfa=require('../src/platform/services/mfa.service');
const createApp=require('../src/app');
const password='CFH-Provision-Integration#2026';
const slug=`probe-tenant-${nonce}-`+'a'.repeat(42-14-nonce.length);
let server;
function csrf(html){const result=html.match(/name="_csrf" value="([a-f0-9]{64})"/);assert(result,'CSRF token rendered');return result[1];}
async function main(){
  await connectPlatformMongo();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
  for(const Model of [Tenant,Identity,Admin,Invite,Audit,PlanVersion,require('../src/platform/models/LoginThrottle'),require('../src/platform/models/SecurityEvent')])await Model.createIndexes();
  const secret=mfa.generateSecret();
  const admin=await Admin.create({name:'Provision Probe Admin',email:`admin-${nonce}@example.invalid`,passwordHash:await bcrypt.hash(password,12),role:'Super Admin',status:'active',mfaSecretEncrypted:mfa.encryptSecret(secret),mfaEnabledAt:new Date(),mfaLastCounter:-1});
  await Identity.create({email:admin.email,kind:'platform',accountId:admin._id});
  server=await new Promise(resolve=>{const srv=createApp({sessionStore:new session.MemoryStore()}).listen(0,()=>resolve(srv));});
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie='';
  async function request(route,fields){
    const response=await fetch(base+route,{redirect:'manual',method:fields?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(fields?{'content-type':'application/x-www-form-urlencoded'}:{})},...(fields?{body:new URLSearchParams(fields).toString()}:{})});
    cookie=response.headers.get('set-cookie')?.split(';')[0]||cookie;
    const html=await response.text();return {response,html};
  }
  const anonymous=await request('/signin');
  const anonymousPublish=await request('/platform/plans/publish-initial',{_csrf:csrf(anonymous.html)});
  assert.equal(anonymousPublish.response.status,303,'anonymous users cannot publish the catalogue');
  assert.equal(anonymousPublish.response.headers.get('location'),'/signin');
  assert.equal(await PlanVersion.countDocuments(),0,'anonymous publication leaves catalogue empty');
  const login=await request('/signin');
  const signed=await request('/signin',{_csrf:csrf(login.html),email:admin.email,password});
  assert.equal(signed.response.headers.get('location'),'/mfa/challenge');
  const challenge=await request('/mfa/challenge');
  const passwordOnlyPublish=await request('/platform/plans/publish-initial',{_csrf:csrf(challenge.html)});
  assert.equal(passwordOnlyPublish.response.status,303,'password-only sessions cannot publish the catalogue');
  assert.equal(passwordOnlyPublish.response.headers.get('location'),'/signin');
  assert.equal(await PlanVersion.countDocuments(),0,'MFA remains a prerequisite for publication');
  const verified=await request('/mfa/challenge',{_csrf:csrf(challenge.html),code:mfa.counterCode(secret,Math.floor(Date.now()/30000))});
  assert.equal(verified.response.headers.get('location'),'/platform/dashboard');
  const values={name:'Provision Probe Tenant',slug:slug.toUpperCase(),owner:'Probe Owner',email:`owner-${nonce}@example.invalid`,phone:'+256 700 000 123',plan:'modular'};
  const emptyForm=await request('/platform/tenants/create');
  assert.equal(emptyForm.response.status,200);
  assert.match(emptyForm.html,/action="\/platform\/plans\/publish-initial"/);
  assert.doesNotMatch(emptyForm.html,/<select[^>]+name="plan"/,'no unusable empty plan selector');
  assert.equal(await PlanVersion.countDocuments(),0,'visiting the form does not publish plans');
  const plansPage=await request('/platform/plans');
  assert.equal(plansPage.response.status,200);
  assert.match(plansPage.html,/action="\/platform\/plans\/publish-initial"/);
  assert.equal(await PlanVersion.countDocuments(),0,'visiting catalogue settings does not mutate published terms');
  const unpublished=await request('/platform/tenants',{...values,_csrf:csrf(emptyForm.html)});
  assert.equal(unpublished.response.status,409);assert.match(unpublished.html,/plan has not been published/);
  assert.equal(await Tenant.countDocuments(),0,'unpublished plans create no tenant');
  const forgedPublish=await request('/platform/plans/publish-initial',{_csrf:'invalid'});
  assert.equal(forgedPublish.response.status,403,'catalogue publication requires a valid CSRF token');
  assert.equal(await PlanVersion.countDocuments(),0,'forged publication leaves catalogue empty');
  const initialized=await request('/platform/plans/publish-initial',{_csrf:csrf(emptyForm.html)});
  assert.equal(initialized.response.status,303,initialized.html);
  assert.equal(initialized.response.headers.get('location'),'/platform/tenants/create');
  assert.equal(await PlanVersion.countDocuments(),5,'the initial catalogue is published through the administrator action');
  assert.equal(await Tenant.countDocuments(),0,'initialization creates plans, not a tenant');
  const publication=await Audit.findOne({action:'catalog.initial_published'}).lean();
  assert(publication,'catalogue initialization is audited');
  assert.equal(publication.actorId,String(admin._id),'publication is attributed to the authenticated administrator');
  const repeated=await request('/platform/plans/publish-initial',{_csrf:csrf(emptyForm.html)});
  assert.equal(repeated.response.status,303,repeated.html);
  assert.equal(repeated.response.headers.get('location'),'/platform/tenants/create');
  assert.equal(await PlanVersion.countDocuments(),5,'repeated initialization does not create duplicate versions');
  assert.equal(await Audit.countDocuments({action:'catalog.initial_published'}),1,'repeated initialization does not create a false mutation audit');
  const form=await request('/platform/tenants/create');assert.equal(form.response.status,200);assert.match(form.html,/Modular Workspace/);
  const invalid=await request('/platform/tenants',{...values,owner:'x'.repeat(121),_csrf:csrf(form.html)});
  assert.equal(invalid.response.status,400);assert.match(invalid.html,/role="alert"/);assert.match(invalid.html,/value="Provision Probe Tenant"/);
  assert.equal(await Tenant.countDocuments(),0,'invalid input creates no tenant');
  const created=await request('/platform/tenants',{...values,_csrf:csrf(invalid.html)});
  assert.equal(created.response.status,200,created.html);
  assert.equal(created.response.headers.get('cache-control'),'no-store');
  const token=created.html.match(/accept-invite#token=([a-f0-9]{64})/)?.[1];assert(token,'private owner invitation rendered');
  const tenant=await Tenant.findOne({slug});assert(tenant);assert.equal(tenant.phone,values.phone);assert.equal(tenant.setupStatus,'invited');
  assert.equal(Buffer.byteLength(tenant.dbName),63,'longest valid slug creates a valid database');
  assert.equal(tenant.subscription.planCode,'modular');assert(tenant.subscription.periodEnd>new Date());assert.deepEqual(tenant.enabledModules,[]);
  const invite=await Invite.findOne({tenantId:tenant._id}).lean();assert(invite);assert(!JSON.stringify(invite).includes(token),'raw invitation token not persisted');
  assert(await Audit.exists({action:'tenant.created',recordId:String(tenant._id)}));
  const againForm=await request('/platform/tenants/create');
  const duplicate=await request('/platform/tenants',{...values,_csrf:csrf(againForm.html)});
  assert.equal(duplicate.response.status,409);assert.match(duplicate.html,/slug is already in use/);assert.equal(await Tenant.countDocuments(),1);
  cookie='';
  const activation=await request('/accept-invite');
  const accepted=await request('/accept-invite',{_csrf:csrf(activation.html),token,password,confirmPassword:password});
  assert.equal(accepted.response.status,303);assert.equal(accepted.response.headers.get('location'),'/signin');
  assert.equal((await Tenant.findById(tenant._id)).setupStatus,'complete');
  assert(await Identity.exists({email:values.email,tenantId:tenant._id}));
  const usedForm=await request('/accept-invite');
  const replay=await request('/accept-invite',{_csrf:csrf(usedForm.html),token,password,confirmPassword:password});
  assert.equal(replay.response.status,400,'owner invitation is single-use');
  const ownerForm=await request('/signin');
  const ownerLogin=await request('/signin',{_csrf:csrf(ownerForm.html),email:values.email,password});
  assert.equal(ownerLogin.response.headers.get('location'),'/mfa/setup','new owner can sign in and enroll MFA');
  console.log('PASS: administrator/MFA/CSRF-protected in-app catalogue recovery, repeatability and audit attribution; HTTP tenant creation, contact persistence, 42-character slug, validation feedback, duplicate rejection, owner activation, single-use invitation and sign-in');
}
async function cleanup(){
  if(server)await new Promise(resolve=>server.close(resolve));
  if(mongoose.connection.readyState===1&&mongoose.connection.name===scratchName&&/^cfh_provision_probe_[a-f0-9]{16}$/.test(scratchName)){
    // This exact random tenant and platform database belong exclusively to this run.
    await getTenantConnection(slug).db.dropDatabase();
    await mongoose.connection.db.dropDatabase();
  }
  await mongoose.disconnect();
}
main().catch(error=>{console.error('Tenant integration FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Tenant integration cleanup FAILED:',error.message);process.exitCode=1;}));
