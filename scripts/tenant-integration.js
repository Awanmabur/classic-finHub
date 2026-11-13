#!/usr/bin/env node
'use strict';
// Full HTTP provisioning lifecycle in random, disposable loopback databases.
// Never targets a remote cluster or drops an existing application database.
require('dotenv').config();
process.env.MFA_ENABLED='true';
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
const slug=`p-${nonce.slice(0,15)}`; // 17 characters: Atlas Free 38-byte tenant DB name
let server;
const extraSlugs=new Set();
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
  const anonymousRenew=await request('/platform/tenants/'+new mongoose.Types.ObjectId()+'/owner-invitation',{_csrf:csrf(anonymous.html),revision:'0',reason:'Recover interrupted owner activation page'});
  assert.equal(anonymousRenew.response.status,303);assert.equal(anonymousRenew.response.headers.get('location'),'/signin');
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
  const values={name:slug+' Finance',slug:slug.toUpperCase(),owner:'Probe Owner',email:`owner-${nonce}@example.invalid`,phone:'+256 700 000 123',plan:'modular'};
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
  assert.equal(invalid.response.status,400);assert.match(invalid.html,/role="alert"/);assert.match(invalid.html,new RegExp('value="'+slug+' Finance"'));
  assert.equal(await Tenant.countDocuments(),0,'invalid input creates no tenant');
  // Actual Mongoose index traversal against a real tenant connection; only
  // its native user's createIndexes command is faulted to emulate Atlas denial.
  const tenantConnection=getTenantConnection(slug),parentAutoIndex=mongoose.connection.config.autoIndex;
  tenantConnection.config.autoIndex=false;
  const User=require('../src/tenant/models').tenantUserModel(tenantConnection);
  const native=User.collection.collection,originalIndex=native.createIndexes;
  let failure='permission',failedIndexes=0;
  native.createIndexes=async function(...args){
    if(failure){failedIndexes++;throw failure==='permission'?new mongoose.mongo.MongoServerError({message:'DO-NOT-ECHO private database command',code:13,codeName:'Unauthorized'}):new mongoose.mongo.MongoNetworkError('DO-NOT-ECHO private network details');}
    return originalIndex.apply(this,args);
  };
  try{
    const denied=await request('/platform/tenants',{...values,_csrf:csrf(invalid.html)});
    assert.equal(denied.response.status,403);assert.match(denied.html,/Atlas Database Access/);assert.match(denied.html,new RegExp('value="'+slug+' Finance"'));assert.doesNotMatch(denied.html,/DO-NOT-ECHO/);assert.match(denied.response.headers.get('cache-control'),/no-store/);
    assert.equal(await Tenant.countDocuments(),0);assert.equal(await Invite.countDocuments(),0);assert.equal(await Audit.countDocuments({action:'tenant.created'}),0);
    assert.equal((await request('/health/ready')).response.status,200,'index permission denial must not disconnect the server');
    failure='network';
    const transient=await request('/platform/tenants',{...values,_csrf:csrf(denied.html)});
    assert.equal(transient.response.status,503);assert.equal(transient.response.headers.get('retry-after'),'5');assert.match(transient.html,/MongoDB became unavailable/);assert.match(transient.html,new RegExp('value="'+slug+' Finance"'));assert.doesNotMatch(transient.html,/DO-NOT-ECHO/);
    assert.equal(await Tenant.countDocuments(),0);assert.equal(await Invite.countDocuments(),0);
    assert.equal((await request('/health/ready')).response.status,200,'a failed index command must leave HTTP ready for a retry');
  }finally{failure='';native.createIndexes=originalIndex;}
  assert(failedIndexes>0,'the native index failure was actually exercised');
  // Revocation while the final DDL stage completes cannot publish a workspace.
  const revokedSlug='r-'+nonce.slice(0,15);extraSlugs.add(revokedSlug);
  const fundedModels=require('../src/tenant/funded/models'),originalEnsure=fundedModels.ensureIndexes;
  fundedModels.ensureIndexes=async function(connection){await originalEnsure(connection);if(connection.name===require('../src/config/tenantDatabaseName').tenantDbNameFromSlug(revokedSlug))await Admin.updateOne({_id:admin._id},{$set:{status:'disabled'}});};
  try{
    const revoked=await request('/platform/tenants',{...values,name:revokedSlug+' Finance',slug:revokedSlug,email:'revoked-owner-'+nonce+'@example.invalid',_csrf:csrf(invalid.html)});
    assert.equal(revoked.response.status,403);assert.match(revoked.html,/Active platform Super Admin/);assert.equal(await Tenant.countDocuments(),0);assert.equal(await Invite.countDocuments(),0);
  }finally{fundedModels.ensureIndexes=originalEnsure;await Admin.updateOne({_id:admin._id},{$set:{status:'active'}});}
  const created=await request('/platform/tenants',{...values,_csrf:csrf(invalid.html)});
  assert.equal(created.response.status,200,created.html);
  assert.equal(created.response.headers.get('cache-control'),'no-store');
  let token=created.html.match(/accept-invite#token=([a-f0-9]{64})/)?.[1];assert(token,'private owner invitation rendered');
  assert.equal(mongoose.connection.config.autoIndex,parentAutoIndex,'tenant setup must not change platform index policy');
  assert.equal(tenantConnection.config.autoIndex,false);
  const indexes=await tenantConnection.db.collection('securemobiletransactions').indexes();assert(indexes.some(index=>index.unique&&index.key.idempotencyKey===1),'unique financial indexes precede publication');
  const tenant=await Tenant.findOne({slug});assert(tenant);assert.equal(tenant.phone,values.phone);assert.equal(tenant.setupStatus,'invited');
  assert.equal(Buffer.byteLength(tenant.dbName),38,'longest allowed new tenant slug fits Atlas Free database limit');
  assert.equal(tenant.subscription.planCode,'modular');assert(tenant.subscription.periodEnd>new Date());assert.deepEqual(tenant.enabledModules,[]);
  const invite=await Invite.findOne({tenantId:tenant._id}).lean();assert(invite);assert(!JSON.stringify(invite).includes(token),'raw invitation token not persisted');
  assert(await Audit.exists({action:'tenant.created',recordId:String(tenant._id)}));
  const againForm=await request('/platform/tenants/create');
  const duplicate=await request('/platform/tenants',{...values,_csrf:csrf(againForm.html)});
  assert.equal(duplicate.response.status,409);assert.match(duplicate.html,/pending invitation/);assert.equal(await Tenant.countDocuments(),1);
  assert.equal(await Invite.countDocuments({tenantId:tenant._id}),1);assert.equal(await Audit.countDocuments({action:'tenant.created'}),1);
  const profile=await request('/platform/tenants/'+tenant._id);assert.equal(profile.response.status,200);assert.match(profile.html,/Create replacement owner activation link/);
  const renewalFields={revision:String(tenant.__v||0),reason:'Recover the interrupted original owner activation page'};
  const forgedRenewal=await request('/platform/tenants/'+tenant._id+'/owner-invitation',{...renewalFields,_csrf:'forged'});assert.equal(forgedRenewal.response.status,403);assert.equal(await Invite.countDocuments({tenantId:tenant._id}),1);
  const renewed=await request('/platform/tenants/'+tenant._id+'/owner-invitation',{...renewalFields,_csrf:csrf(profile.html)});
  assert.equal(renewed.response.status,200,renewed.html);assert.match(renewed.html,/Owner activation link replaced/);assert.equal(renewed.response.headers.get('cache-control'),'no-store');
  const originalToken=token;token=renewed.html.match(/accept-invite#token=([a-f0-9]{64})/)?.[1];assert(token);assert.notEqual(token,originalToken);assert.equal(await Tenant.countDocuments(),1);assert.equal(await Invite.countDocuments({tenantId:tenant._id}),2);assert.equal(await Invite.countDocuments({tenantId:tenant._id,usedAt:null,expiresAt:{$gt:new Date()}}),1);assert.equal(await Audit.countDocuments({action:'tenant.invitation_regenerated'}),1);
  const staleRenewal=await request('/platform/tenants/'+tenant._id+'/owner-invitation',{...renewalFields,_csrf:csrf(profile.html)});assert.equal(staleRenewal.response.status,409);assert.equal(await Invite.countDocuments({tenantId:tenant._id}),2);
  const administratorCookie=cookie;
  cookie='';
  const activation=await request('/accept-invite');
  const oldActivation=await request('/accept-invite',{_csrf:csrf(activation.html),token:originalToken,password,confirmPassword:password});assert.equal(oldActivation.response.status,400,'replaced owner links must not activate');
  const accepted=await request('/accept-invite',{_csrf:csrf(activation.html),token,password,confirmPassword:password});
  assert.equal(accepted.response.status,303);assert.equal(accepted.response.headers.get('location'),'/signin');
  assert.equal((await Tenant.findById(tenant._id)).setupStatus,'complete');
  assert(await Identity.exists({email:values.email,tenantId:tenant._id}));
  const ownerCookie=cookie;cookie=administratorCookie;
  const activated=await Tenant.findById(tenant._id).lean();
  const activeProfile=await request('/platform/tenants/'+tenant._id);assert.doesNotMatch(activeProfile.html,/Create replacement owner activation link/);
  const activeRenewal=await request('/platform/tenants/'+tenant._id+'/owner-invitation',{revision:String(activated.__v||0),reason:renewalFields.reason,_csrf:csrf(activeProfile.html)});assert.equal(activeRenewal.response.status,409);assert.equal(await Invite.countDocuments({tenantId:tenant._id}),2);cookie=ownerCookie;
  const usedForm=await request('/accept-invite');
  const replay=await request('/accept-invite',{_csrf:csrf(usedForm.html),token,password,confirmPassword:password});
  assert.equal(replay.response.status,400,'owner invitation is single-use');
  const ownerForm=await request('/signin');
  const ownerLogin=await request('/signin',{_csrf:csrf(ownerForm.html),email:values.email,password});
  assert.equal(ownerLogin.response.headers.get('location'),'/mfa/setup','new owner can sign in and enroll MFA');
  console.log('PASS: native index fault injection retains form and server readiness; retry publishes only after unique indexes; administrator revocation blocks late publication; audited owner-link recovery expires old links and rejects stale/activated requests; administrator/MFA/CSRF-protected in-app catalogue recovery, repeatability and audit attribution; HTTP tenant creation, contact persistence, 17-character generated database names, validation feedback, duplicate rejection, owner activation, single-use invitation and sign-in');
}
async function cleanup(){
  if(server)await new Promise(resolve=>server.close(resolve));
  if(mongoose.connection.readyState===1&&mongoose.connection.name===scratchName&&/^cfh_provision_probe_[a-f0-9]{16}$/.test(scratchName)){
    // This exact random tenant and platform database belong exclusively to this run.
    for(const candidate of [slug,...extraSlugs])await getTenantConnection(candidate).db.dropDatabase();
    await mongoose.connection.db.dropDatabase();
  }
  await mongoose.disconnect();
}
main().catch(error=>{console.error('Tenant integration FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Tenant integration cleanup FAILED:',error.message);process.exitCode=1;}));
