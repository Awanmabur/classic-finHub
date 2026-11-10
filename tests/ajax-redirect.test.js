'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),session=require('express-session');
const {ajaxRedirect}=require('../src/middleware/ajaxRedirect');
const {flash,consumeFlash}=require('../src/utils/view');
const csrf=require('../src/middleware/csrfProtection');
async function listen(t,app){const server=await new Promise(resolve=>{const server=app.listen(0,()=>resolve(server));});t.after(()=>new Promise(resolve=>server.close(resolve)));return 'http://127.0.0.1:'+server.address().port;}
async function open(base){const response=await fetch(base+'/signin');return {cookie:response.headers.get('set-cookie').split(';')[0],...(await response.json())};}
function post(base,path,identity,values={},headers={}){return fetch(base+path,{method:'POST',redirect:'manual',headers:{cookie:identity.cookie,'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams({_csrf:identity.csrf,...values})});}
function fixture(){
 const app=express(),visits={destination:0};
 app.use(express.urlencoded({extended:false}));app.use(session({secret:'isolated-redirect-probe-session-secret',resave:false,saveUninitialized:false}));app.use(csrf);app.use(ajaxRedirect);
 app.get('/signin',(req,res)=>res.json({csrf:req.session.csrfToken,flash:consumeFlash(req)||null}));
 app.post('/good',(req,res)=>{flash(req,'good','Branch updated and audited.');res.redirect(303,'/destination?filter=active#funding-history');});
 app.post('/bad',(req,res)=>{flash(req,'bad','Invalid email or password.');res.redirect(303,'/signin');});
 app.post('/target',(req,res)=>res.redirect(303,req.body.target));
 app.get('/destination',(req,res)=>{visits.destination++;res.json({flash:consumeFlash(req)||null});});
 app.use((error,_req,res,_next)=>res.status(error.status||500).type('text/plain').send(error.status<500?error.message:'Request failed'));
 return {app,visits};
}
test('opt-in redirects avoid the invisible GET and preserve a success message for actual navigation',async t=>{
 const {app,visits}=fixture(),base=await listen(t,app),identity=await open(base);
 const response=await post(base,'/good',identity,{}, {'X-ClassicFin-Redirect':'json'});
 assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/private, no-store/);
 const body=await response.json();assert.deepEqual(body,{redirect:'/destination?filter=active#funding-history',flash:{type:'good',message:'Branch updated and audited.'}});
 assert.equal(visits.destination,0,'The mutation must not render the destination invisibly');
 const navigation=await fetch(base+body.redirect,{headers:{cookie:identity.cookie}});assert.deepEqual((await navigation.json()).flash,body.flash);assert.equal(visits.destination,1);
 assert.equal((await(await fetch(base+'/destination',{headers:{cookie:identity.cookie}})).json()).flash,null,'Actual navigation consumes the message once');
});
test('bad sign-in feedback is delivered to the open form without lingering in another page',async t=>{
 const {app}=fixture(),base=await listen(t,app),identity=await open(base);
 const response=await post(base,'/bad',identity,{}, {'X-ClassicFin-Redirect':'json'});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{redirect:'/signin',flash:{type:'bad',message:'Invalid email or password.'}});
 const page=await fetch(base+'/signin',{headers:{cookie:identity.cookie}});assert.equal((await page.json()).flash,null);
});
test('ordinary form posts retain native 303 navigation and their flash',async t=>{
 const {app,visits}=fixture(),base=await listen(t,app),identity=await open(base);
 const response=await post(base,'/good',identity);assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/destination?filter=active#funding-history');assert.equal(visits.destination,0);
 const page=await fetch(base+response.headers.get('location'),{headers:{cookie:identity.cookie}});assert.equal((await page.json()).flash.message,'Branch updated and audited.');
});
test('external, ambiguous and control-character redirects are rejected without disclosing their targets',async t=>{
 const {app}=fixture(),base=await listen(t,app),identity=await open(base);
 for(const target of ['https://private.example.invalid/callback?token=private-value','//private.example.invalid/path','/\\private.example.invalid','/next\nInjected: private-value','/next\u0000private-value','/next path']){
  const response=await post(base,'/target',identity,{target},{'X-ClassicFin-Redirect':'json'});assert.equal(response.status,400);const text=await response.text();assert.match(text,/Open this action from its page/);assert.doesNotMatch(text,/private-value|private\.example|Injected/);assert.equal(response.headers.get('location'),null);
 }
});
test('the real application checks CSRF before applying the JSON redirect contract',async t=>{
 const base=await listen(t,require('../src/app')());
 const signin=await fetch(base+'/signin'),html=await signin.text(),cookie=signin.headers.get('set-cookie').split(';')[0],token=html.match(/name="_csrf" value="([a-f0-9]{64})"/)?.[1];assert(token);
 const headers={cookie,'content-type':'application/x-www-form-urlencoded','X-ClassicFin-Redirect':'json'};
 const denied=await fetch(base+'/logout',{method:'POST',redirect:'manual',headers,body:new URLSearchParams({_csrf:'forged'})});assert.equal(denied.status,403);assert.doesNotMatch(denied.headers.get('content-type'),/application\/json/);assert.equal(denied.headers.get('location'),null);
 const accepted=await fetch(base+'/logout',{method:'POST',redirect:'manual',headers,body:new URLSearchParams({_csrf:token})});assert.equal(accepted.status,200);assert.deepEqual(await accepted.json(),{redirect:'/signin',flash:null});
});
