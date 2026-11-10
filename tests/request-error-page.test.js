'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),path=require('node:path');
const errorHandler=require('../src/middleware/errorHandler');
const reference='78ce216d-cdf8-4e70-8d60-865032876d9f';
async function fixture(t,{brokenView=false}={}){
 const logs=[];t.mock.method(console,'error',message=>logs.push(message));
 const app=express();app.set('view engine','ejs');app.set('views',path.resolve(__dirname,brokenView?'missing-error-views':'../src/views'));app.use(express.urlencoded({extended:false}));
 app.use('/css',express.static(path.resolve(__dirname,'../public/css')));
 app.use((req,_res,next)=>{req.requestId=reference;next();});
 app.get('/storage',(req,_res,next)=>{req.user={id:'synthetic-tenant-user'};next(Object.assign(Error('Private storage diagnostic: private-user private-password private-host private-token'),{name:'MongoNetworkError'}));});
 app.post('/financial',(req,_res,next)=>{req.user={id:'synthetic-tenant-user'};next(new TypeError('private-exception '+req.body.password+' '+req.body.customer));});
 app.get('/validation',(req,_res,next)=>next(Object.assign(Error('<script>privateExecutable()</script> & "invalid choice"'),{status:422})));
 app.get('/platform',(req,_res,next)=>{req.platformUser={id:'synthetic-platform-admin'};next(Error('private-platform-diagnostics'));});
 app.use(errorHandler);
 const server=await new Promise(resolve=>{const server=app.listen(0,()=>resolve(server));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 return {base:'http://127.0.0.1:'+server.address().port,logs};
}
test('a browser storage failure presents a styled safe alert and one GET retry without exposing driver details',async t=>{
 const {base,logs}=await fixture(t),response=await fetch(base+'/storage?from=2026-11-01&to=2026-11-09',{headers:{Accept:'text/html'}}),html=await response.text();
 assert.equal(response.status,503);assert.match(response.headers.get('content-type'),/text\/html/);assert.equal(response.headers.get('retry-after'),'5');assert.equal(response.headers.get('x-error-reference'),reference);
 assert.match(response.headers.get('cache-control'),/private, no-store/);assert.match(response.headers.get('x-robots-tag'),/noindex, nofollow, noarchive/);
 assert.match(html,/class="requestError"/);assert.match(html,/href="\/css\/request-error\.css"/);assert.match(html,/role="alert"/);assert.match(html,/Storage is temporarily unavailable/);assert.match(html,new RegExp('Reference: '+reference));
 assert.match(html,/href="\/storage\?from=2026-11-01&amp;to=2026-11-09">Try opening this page again/);assert.match(html,/href="\/tenant\/dashboard"/);
 assert.doesNotMatch(html,/private-user|private-password|private-host|private-token|mongodb:/);assert.doesNotMatch(logs.join('\n'),/private-user|private-password|private-host|private-token/);
 const css=await fetch(base+'/css/request-error.css');assert.equal(css.status,200);assert.match(css.headers.get('content-type'),/text\/css/);assert.match(await css.text(),/\.requestError/);
});
test('a failed financial POST never offers resubmission or reflects submitted private information',async t=>{
 const {base,logs}=await fixture(t),response=await fetch(base+'/financial',{method:'POST',headers:{Accept:'text/html','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password:'private-password-value',customer:'private-customer-value'})}),html=await response.text();
 assert.equal(response.status,500);assert.match(html,/role="alert"/);assert.match(html,/An unexpected error occurred/);assert.match(html,/Your request has not been sent again/);assert.match(html,/Check the operation history/);assert.match(html,/href="\/tenant\/dashboard">Return to workspace/);
 assert.doesNotMatch(html,/<form\b|<input\b|Try opening this page again|href="\/financial/);assert.doesNotMatch(html,/private-exception|private-password-value|private-customer-value|TypeError/);assert.doesNotMatch(logs.join('\n'),/private-exception|private-password-value|private-customer-value/);
 assert.match(response.headers.get('cache-control'),/no-store/);assert.match(response.headers.get('x-robots-tag'),/noindex/);
});
test('validation messages render as escaped text and platform failures return to the platform workspace',async t=>{
 const {base}=await fixture(t),response=await fetch(base+'/validation',{headers:{Accept:'text/html'}}),html=await response.text();assert.equal(response.status,422);
 assert.match(html,/&lt;script&gt;privateExecutable\(\)&lt;\/script&gt; &amp; &#34;invalid choice&#34;/);assert.doesNotMatch(html,/<script>|class="reference"/);assert.match(html,/href="\/signin"/);
 // fetch owns Sec-Fetch-Mode and replaces a caller's navigate value with cors;
 // send a real document-mode request with the native HTTP client instead.
 const platform=await new Promise((resolve,reject)=>{require('node:http').get(base+'/platform',{headers:{'Sec-Fetch-Mode':'navigate'}},response=>{let html='';response.setEncoding('utf8');response.on('data',chunk=>{html+=chunk;});response.on('end',()=>resolve({status:response.statusCode,html}));}).on('error',reject);});
 assert.equal(platform.status,500);assert.match(platform.html,/href="\/platform\/dashboard">Return to workspace/);assert.doesNotMatch(platform.html,/private-platform-diagnostics/);
});
test('API consumers keep plain error responses, status codes and retry guidance',async t=>{
 const {base}=await fixture(t),response=await fetch(base+'/storage',{headers:{Accept:'application/json'}}),body=await response.text();
 assert.equal(response.status,503);assert.match(response.headers.get('content-type'),/text\/plain/);assert.equal(response.headers.get('retry-after'),'5');assert.equal(response.headers.get('x-error-reference'),reference);assert.match(body,/Storage is temporarily unavailable/);assert.match(body,new RegExp('Reference: '+reference));assert.doesNotMatch(body,/<html|private-password|private-token/);
});
test('a view-rendering failure falls back to the same safe plain message while retaining error status and headers',async t=>{
 const {base,logs}=await fixture(t,{brokenView:true}),response=await fetch(base+'/storage',{headers:{Accept:'text/html'}}),body=await response.text();
 assert.equal(response.status,503);assert.match(response.headers.get('content-type'),/text\/plain/);assert.equal(response.headers.get('retry-after'),'5');assert.equal(response.headers.get('x-error-reference'),reference);assert.match(response.headers.get('cache-control'),/no-store/);assert.match(response.headers.get('x-robots-tag'),/noindex/);
 assert.match(body,/Storage is temporarily unavailable/);assert.match(body,new RegExp('Reference: '+reference));assert.doesNotMatch(body,/Failed to lookup|missing-error-views|private-password|private-token/);assert.doesNotMatch(logs.join('\n'),/private-password|private-token/);
});
