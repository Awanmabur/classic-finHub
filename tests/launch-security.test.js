'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const express=require('express'),session=require('express-session');
const headers=require('../src/middleware/securityHeaders');
const csrf=require('../src/middleware/csrfProtection');

async function serverFor(app,t){const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));return 'http://127.0.0.1:'+server.address().port;}

test('private URL cache protections cover the same mixed-case paths as Express routing',async t=>{
 const app=express();app.use(...headers);app.get('*',(_req,res)=>res.send('route response'));
 const origin=await serverFor(app,t);
 for(const pathname of ['/TeNaNt/dashboard','/PlAtFoRm/plans','/SiGnIn','/ReSeT-PaSsWoRd','/MfA/challenge','/InTeGrAtIoNs/sms/device','/LoGoUt','/T/published','/HeAlTh/ready']){
  const response=await fetch(origin+pathname);
  assert.match(response.headers.get('cache-control')||'',/no-store/,pathname);
  assert.match(response.headers.get('x-robots-tag')||'',/noindex/,pathname);
 }
 const publicResponse=await fetch(origin+'/pricing');assert.equal(publicResponse.headers.get('cache-control'),null,'public page caching policy is not replaced by a private policy');
 const csp=publicResponse.headers.get('content-security-policy');assert.match(csp,/font-src 'self';/);assert.doesNotMatch(csp,/fonts\.googleapis|fonts\.gstatic|cdnjs\.cloudflare/);
});

test('mixed-case authentication forms get a usable CSRF token without relaxing token checks',async t=>{
 const app=express();app.use(session({secret:'test-only-session-secret-long-enough',resave:false,saveUninitialized:false}));app.use(express.urlencoded({extended:false}));app.use(csrf);
 app.get('/signin',(_req,res)=>res.json({csrf:res.locals.csrfToken}));app.post('/signin',(_req,res)=>res.status(204).end());app.use((error,_req,res,_next)=>res.status(error.status||500).send('rejected'));
 const origin=await serverFor(app,t),form=await fetch(origin+'/SiGnIn'),cookie=form.headers.get('set-cookie').split(';')[0],data=await form.json();
 assert.match(data.csrf,/^[a-f0-9]{64}$/);
 const post=token=>fetch(origin+'/SiGnIn',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:token})});
 assert.equal((await post('wrong-token')).status,403);assert.equal((await post(data.csrf)).status,204);
});

test('production configuration requires explicit named Mongo storage and valid listening ports',()=>{
 const base={...process.env,NODE_ENV:'production',APP_URL:'https://fin.example',TRUST_PROXY:'1',SESSION_SECRET:'test-session-secret-'.repeat(4),MFA_ENCRYPTION_KEY:'ab'.repeat(32),PORT:'3000',MONGO_PLATFORM_URI:'mongodb://db-a:27017,db-b:27017/platform?replicaSet=rs0'};
 const run=extra=>spawnSync(process.execPath,['-e',"require('./src/config/env')"],{cwd:path.resolve(__dirname,'..'),env:{...base,...extra},encoding:'utf8'});
 assert.equal(run({}).status,0,'legitimate multi-host replica-set URIs remain supported');
 assert.equal(run({MONGO_PLATFORM_URI:'mongodb+srv://cluster.example/platform'}).status,0,'SRV connection URIs remain supported');
 for(const value of ['', 'mongodb://db-a:27017', 'mongodb+srv://cluster.example/']){const result=run({MONGO_PLATFORM_URI:value});assert.notEqual(result.status,0);assert.match(result.stderr,/MONGO_PLATFORM_URI/);}
 for(const value of ['0','-1','65536','not-a-port']){const result=run({PORT:value});assert.notEqual(result.status,0);assert.match(result.stderr,/PORT/);}
 assert.equal(run({PORT:'65535'}).status,0);
});
