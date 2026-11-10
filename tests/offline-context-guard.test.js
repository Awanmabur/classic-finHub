'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express');
const guard=require('../src/middleware/requireOfflineContext'),identity=require('../src/tenant/services/offlineIdentity');
const ids={tenant:'507f1f77bcf86cd799439011',user:'507f1f77bcf86cd799439012',branch:'507f1f77bcf86cd799439013',other:'507f1f77bcf86cd799439014'};
function context(){return {tenant:{_id:ids.tenant},user:{id:ids.user,authVersion:3},operationBranch:{_id:ids.branch},viewBranchId:ids.other};}
async function fixture(t){
 let current=context(),mutations=0;const app=express();
 app.use((req,_res,next)=>{if(req.path!=='/unbound')Object.assign(req,structuredClone(current));next();});app.use(guard);
 app.post('/transfer',(_req,res)=>{mutations++;res.json({accepted:true});});app.post('/unbound',(_req,res)=>res.sendStatus(204));app.get('/unbound',(_req,res)=>res.sendStatus(204));
 app.use((error,_req,res,_next)=>res.status(error.status||500).type('text/plain').send(error.message));
 const server=await new Promise(resolve=>{const server=app.listen(0,()=>resolve(server));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;
 return {scope:identity(current),change:value=>{current={...current,...value};},mutations:()=>mutations,request:(headers={},path='/transfer',method='POST')=>fetch(base+path,{method,headers})};
}
function binding(scope){return {'X-ClassicFin-Offline-Scope':scope.scope,'X-ClassicFin-Offline-Branch':scope.branchId};}
test('a queued instruction matches its original account version and operating branch, independent of read view',async t=>{
 const server=await fixture(t),headers=binding(server.scope);headers['X-ClassicFin-Offline-Branch']=headers['X-ClassicFin-Offline-Branch'].toUpperCase();
 assert.equal((await server.request(headers)).status,200);assert.equal(server.mutations(),1);
 server.change({viewBranchId:ids.branch});assert.equal((await server.request(headers)).status,200);assert.equal(server.mutations(),2,'A reporting view does not reassign the operating branch');
});
test('branch reassignment rejects a formerly valid queued instruction before mutation',async t=>{
 const server=await fixture(t);server.change({operationBranch:{_id:ids.other}});
 const response=await server.request(binding(server.scope));assert.equal(response.status,409);assert.match(await response.text(),/account or operating branch changed/);assert.equal(server.mutations(),0);
});
test('a changed account credential version or identity invalidates the original queued scope',async t=>{
 const server=await fixture(t),headers=binding(server.scope);
 for(const user of [{id:ids.user,authVersion:4},{id:ids.other,authVersion:3}]){server.change({user});assert.equal((await server.request(headers)).status,409);}
 server.change({user:{id:ids.user,authVersion:3},tenant:{_id:ids.other}});assert.equal((await server.request(headers)).status,409);assert.equal(server.mutations(),0);
});
test('forged, malformed or incomplete binding headers cannot reach the financial handler',async t=>{
 const server=await fixture(t),valid=binding(server.scope);
 for(const headers of [
  {...valid,'X-ClassicFin-Offline-Scope':'0'.repeat(64)},
  {...valid,'X-ClassicFin-Offline-Scope':'not-a-scope'},
  {'X-ClassicFin-Offline-Scope':server.scope.scope},
  {...valid,'X-ClassicFin-Offline-Branch':'invalid'},
  {...valid,'X-ClassicFin-Offline-Branch':ids.other}
 ])assert.equal((await server.request(headers)).status,409);
 server.change({operationBranch:null});assert.equal((await server.request(valid)).status,409);assert.equal(server.mutations(),0);
});
test('unbound ordinary actions and GET requests remain unaffected',async t=>{
 const server=await fixture(t);assert.equal((await server.request({},'/unbound')).status,204);
 assert.equal((await server.request({'X-ClassicFin-Offline-Scope':'invalid'},'/unbound','GET')).status,204);
});
