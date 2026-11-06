'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {sessionScope,createTrafficLimiter}=require('../src/middleware/rateLimiter');
const ids=['507f1f77bcf86cd799439011','507f1f77bcf86cd799439012','507f1f77bcf86cd799439013','507f1f77bcf86cd799439014'];
function session(index=1){return {authenticatedAt:Date.now(),tenantId:ids[0],identityId:ids[2],tenantUserId:ids[index]};}
test('workspace budgets use server session identity and reject incomplete, expired or header-only contexts',()=>{
 assert.notEqual(sessionScope({session:session(1)}),sessionScope({session:session(3)}));
 for(const invalid of [{},{tenantUserId:ids[1],identityId:ids[2]}, {...session(),authenticatedAt:0},{...session(),identityId:'bad'}])assert.equal(sessionScope({session:invalid}),null);
 assert.equal(sessionScope({headers:{'x-tenant-user-id':ids[1]}}),null);
});
test('two staff behind one IP retain separate bounded budgets; assets do not consume page requests',async()=>{
 const app=express();
 app.get('/asset.css',(_req,res)=>res.type('text/css').send('body{}'));
 // Test fixture creates server-session state before exercising production limiter.
 app.use((req,_res,next)=>{if(req.path.startsWith('/staff-a'))req.session=session(1);if(req.path.startsWith('/staff-b'))req.session=session(3);next();});
 app.use(createTrafficLimiter({publicLimit:2,accountLimit:2}).traffic);
 app.get('*',(_req,res)=>res.send('ok'));
 const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  for(let i=0;i<5;i++)assert.equal((await fetch(base+'/asset.css')).status,200);
  for(const path of ['/staff-a','/staff-b','/public']){
   assert.equal((await fetch(base+path)).status,200);assert.equal((await fetch(base+path)).status,200);
   const blocked=await fetch(base+path);assert.equal(blocked.status,429);assert(blocked.headers.get('retry-after'));
  }
 }finally{await new Promise(resolve=>server.close(resolve));}
});
