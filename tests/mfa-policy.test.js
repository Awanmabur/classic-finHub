'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const bcrypt=require('bcryptjs');
const policy=require('../src/config/mfaPolicy');
const {createAuthenticator}=require('../src/platform/services/authentication.service');
const {createRequireAuth}=require('../src/middleware/requireAuth');
const {sessionScope}=require('../src/middleware/rateLimiter');
const ids=['507f1f77bcf86cd799439011','507f1f77bcf86cd799439012','507f1f77bcf86cd799439013'];
function restorePolicy(t){const previous=process.env.MFA_ENABLED;t.after(()=>{if(previous===undefined)delete process.env.MFA_ENABLED;else process.env.MFA_ENABLED=previous;});}
function response(){return{code:null,status(code){this.code=code;return this;},send(message){this.message=message;return this;},redirect(code,path){this.code=code;this.path=path;return this;}};}

test('MFA defaults defer development enrollment and preserve production enforcement',()=>{
 for(const NODE_ENV of [undefined,'development','test'])for(const MFA_ENABLED of [undefined,'','  ']){
  assert.deepEqual(policy.status({NODE_ENV,MFA_ENABLED}),{enabled:false,mode:'disabled',source:'development_default'});
 }
 for(const MFA_ENABLED of [undefined,'','  '])assert.deepEqual(policy.status({NODE_ENV:'production',MFA_ENABLED}),{enabled:true,mode:'enabled',source:'production_default'});
 for(const NODE_ENV of [undefined,'development','production']){
  for(const MFA_ENABLED of ['false','FALSE',' False '])assert.deepEqual(policy.status({NODE_ENV,MFA_ENABLED}),{enabled:false,mode:'disabled',source:'explicit'});
  for(const MFA_ENABLED of ['true','TRUE',' True '])assert.deepEqual(policy.status({NODE_ENV,MFA_ENABLED}),{enabled:true,mode:'enabled',source:'explicit'});
  for(const MFA_ENABLED of ['0','invalid'])assert.deepEqual(policy.status({NODE_ENV,MFA_ENABLED}),{enabled:true,mode:'enabled',source:'invalid_value'});
 }
});

test('optional MFA retains correct passwords and enrollment while changing only the login requirement',async t=>{
 restorePolicy(t);const password='MFA-Policy-Only#2026',passwordHash=await bcrypt.hash(password,4);
 const row={_id:ids[0],email:'policy@example.invalid',status:'active',role:'Tenant Owner',passwordHash,mfaEnabledAt:new Date(),authVersion:2};
 const lookup=value=>({findOne:()=>({lean:async()=>value})});
 const authenticate=createAuthenticator({Identity:lookup({_id:ids[1],kind:'tenant',accountId:ids[0],tenantId:ids[2]}),
  TenantModel:lookup({_id:ids[2],slug:'policy-test',status:'active'}),tenantConnection:()=>({}),getUserModel:()=>lookup(row)});
 process.env.MFA_ENABLED='false';
 const result=await authenticate({email:row.email,password});
 assert.equal(result.mfaRequired,false);assert.equal(result.mfaEnrolled,true);
 assert.equal(await authenticate({email:row.email,password:'wrong-password'}),null);
 process.env.MFA_ENABLED='true';
 assert.equal((await authenticate({email:row.email,password})).mfaRequired,true);
 assert.equal(row.authVersion,2);assert(row.mfaEnabledAt);
});

test('tenant sessions bypass only MFA while disabled and require genuine verification when enabled again',async t=>{
 restorePolicy(t);
 const account={_id:ids[0],email:'owner@example.invalid',role:'Tenant Owner',authVersion:2,allowedModules:[],mfaEnabledAt:null};
 let mapped=true;
 const guard=createRequireAuth({getConnection:()=>({}),getUserModel:()=>({findOne:()=>({lean:async()=>account})}),identityExists:async()=>mapped});
 const req={tenant:{_id:ids[2],slug:'policy-test',status:'active'},path:'/dashboard',session:{tenantUserId:ids[0],identityId:ids[1],authVersion:2,authenticatedAt:Date.now()}};
 process.env.MFA_ENABLED='false';let next=false;let res=response();
 await guard(req,res,error=>{assert.ifError(error);next=true;});assert.equal(next,true);
 assert.equal(req.session.mfaVerifiedAt,undefined);assert.equal(account.mfaEnabledAt,null);
 mapped=false;res=response();await guard(req,res,()=>assert.fail('identity must remain required'));assert.equal(res.code,401);mapped=true;
 req.session.authVersion=1;res=response();await guard(req,res,()=>assert.fail('stale sessions must remain revoked'));assert.equal(res.code,401);req.session.authVersion=2;
 process.env.MFA_ENABLED='true';res=response();await guard(req,res,()=>assert.fail('password-only session cannot satisfy re-enabled MFA'));assert.equal(res.code,401);
 account.mfaEnabledAt=new Date();req.session.mfaVerifiedAt=Date.now();res=response();
 await guard(req,res,error=>{assert.ifError(error);});assert.equal(res.code,null);
});

test('platform gates and rate buckets honor optional MFA without promoting unauthenticated sessions',async t=>{
 restorePolicy(t);const Admin=require('../src/platform/models/PlatformAdmin'),Identity=require('../src/platform/models/AccountIdentity');
 const account={_id:ids[0],email:'admin@example.invalid',role:'Super Admin',authVersion:2,mfaEnabledAt:null};
 t.mock.method(Admin,'findOne',()=>({lean:async()=>account}));t.mock.method(Identity,'exists',async()=>({_id:ids[1]}));
 const guard=require('../src/middleware/requirePlatformAuth');
 const req={session:{platformId:ids[0],identityId:ids[1],authVersion:2,authenticatedAt:Date.now()}};
 process.env.MFA_ENABLED='false';let next=false;let res=response();
 await guard(req,res,error=>{assert.ifError(error);next=true;});assert.equal(next,true);assert.equal(req.session.mfaVerifiedAt,undefined);
 assert.equal(sessionScope(req),`platform:${ids[0]}:${ids[1]}`);assert.equal(sessionScope({session:{platformId:ids[0],identityId:ids[1]}}),null);
 process.env.MFA_ENABLED='true';res=response();await guard(req,res,()=>assert.fail('MFA is required again'));assert.equal(res.code,303);assert.equal(sessionScope(req),null);
 account.mfaEnabledAt=new Date();req.session.mfaVerifiedAt=Date.now();res=response();await guard(req,res,error=>assert.ifError(error));assert.equal(res.code,null);
 account.role='Viewer';process.env.MFA_ENABLED='false';res=response();await guard(req,res,()=>assert.fail('fixed administrator role is still required'));assert.equal(res.code,401);
});
