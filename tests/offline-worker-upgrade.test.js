'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function worker({online=true}={}){
 const events={},fetched=[],matched=[];
 const sandbox={URL,Request,Error,Promise,self:{CLASSICFIN_ASSET_VERSION:'current',location:{origin:'https://fin.example'},addEventListener:(name,handler)=>{events[name]=handler;}},
  caches:{open:async()=>({match:async path=>{matched.push(path);return {source:'cached',path};}})},
  fetch:async request=>{fetched.push(request.url);if(!online)throw Error('offline');return {source:'network'};}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/offline-sw.js'),'utf8'),sandbox);
 return {fetched,matched,async request(path,{method='GET',mode='cors'}={}){let response;events.fetch({request:{method,mode,url:'https://fin.example'+path},respondWith:promise=>{response=promise;}});return response&&await response;}};
}
test('a controlling worker fetches a newly deployed asset version instead of stale cached JavaScript',async()=>{
 const runtime=worker();assert.equal((await runtime.request('/js/offline-workspace.js?v=next')).source,'network');assert.equal(runtime.fetched.length,1);assert.deepEqual(runtime.matched,[]);
 assert.equal((await runtime.request('/js/offline-workspace.js?v=current')).source,'cached');assert.equal(runtime.fetched.length,1);
});
test('saved workspace assets remain available offline across a version change',async()=>{
 const runtime=worker({online:false});assert.equal((await runtime.request('/js/offline-workspace.js?v=previous')).source,'cached');assert.deepEqual(runtime.matched,['/js/offline-workspace.js']);
});
test('worker keeps private pages out of public cache and never intercepts financial POSTs',async()=>{
 const runtime=worker();assert.equal(await runtime.request('/tenant/money-transfer/requests',{method:'POST'}),undefined);
 assert.equal((await runtime.request('/tenant/dashboard',{mode:'navigate'})).source,'network');assert.deepEqual(runtime.matched,[]);
 const offline=worker({online:false});assert.equal((await offline.request('/tenant/dashboard',{mode:'navigate'})).path,'/offline.html');assert.deepEqual(offline.matched,['/offline.html']);
});
