'use strict';
const test = require('node:test');const assert = require('node:assert/strict');
const createApp=require('../src/app');
let server, base;
test.before(async()=>{await new Promise(resolve=>{server=createApp().listen(0,resolve)});base=`http://127.0.0.1:${server.address().port}`;});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));});
test('public pages and crawl metadata render without a database',async()=>{
  for(const page of ['/','/pricing','/price-compare','/robots.txt','/sitemap.xml']){
    const r=await fetch(base+page);assert.equal(r.status,200,page);
    const content=await r.text();assert(content.length > (page==='/robots.txt' ? 15 : 50));
  }
});
test('anonymous platform and tenant dashboards redirect to sign in',async()=>{
  for(const p of ['/tenant/dashboard','/tenant/mobile-money','/tenant/reports','/platform/dashboard','/platform/tenants']){
    const r=await fetch(base+p,{redirect:'manual'});assert.equal(r.status,303,p);assert.equal(r.headers.get('location'),'/signin');
    assert.match(r.headers.get('x-robots-tag'),/noindex/);
  }
});
test('readiness does not claim success while database is disconnected',async()=>{
  const r=await fetch(base+'/health/ready');assert.equal(r.status,503);
});
test('CSRF prevents forged sign-in and state changes',async()=>{
  let r=await fetch(base+'/signin');const page=await r.text();const cookie=r.headers.get('set-cookie')?.split(';')[0];
  const token=page.match(/name="_csrf" value="([^"]+)"/)[1];
  assert(cookie);assert(token);
  r=await fetch(base+'/signin',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',cookie},body:'side=platform&email=x%40y.com&password=x',redirect:'manual'});
  assert.equal(r.status,403);
  r=await fetch(base+'/logout',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',cookie},body:'',redirect:'manual'});
  assert.equal(r.status,403);
});
test('HTTP security headers are present and private responses disable caching',async()=>{
  const r=await fetch(base+'/signin');
  assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  assert.match(r.headers.get('cache-control'),/no-store/);
  assert.match(r.headers.get('content-security-policy'),/default-src/);
  const scriptDirective = r.headers.get('content-security-policy').match(/script-src[^;]+/)[0];
  assert.doesNotMatch(scriptDirective,/unsafe-inline/);
  assert.match(scriptDirective,/'self'/);
});

test('activation pages keep invitation tokens out of GET requests',async()=>{
  for (const page of ['/accept-invite','/accept-staff-invite?tenant=example-org']) {
    const response=await fetch(base+page);
    assert.equal(response.status,200,page);
    assert.match(response.headers.get('cache-control'),/no-store/);
    assert.match(response.headers.get('referrer-policy'),/no-referrer/);
    const html=await response.text();
    assert.match(html,/data-activation-form hidden/);
    assert.match(html,/name="_csrf" value="[a-f0-9]{64}"/);
    assert.match(html,/src="\/js\/activation.js"/);
    assert.doesNotMatch(html,/value="[a-f0-9]{64}" data-activation-token/);
  }
});

test('unified sign-in renders only email and password; recovery forms submit usable names', async()=>{
  const login=await (await fetch(base+'/signin')).text();
  const form=login.match(/<form autocomplete="on" method="post" action="\/signin">([\s\S]*?)<\/form>/);
  assert(form, 'expected the existing styled login form');
  const controls=[...form[1].matchAll(/name="([^"]+)"/g)].map(x=>x[1]);
  assert.deepEqual(controls,['_csrf','email','password']);
  assert.doesNotMatch(login,/Tenant slug \(tenant users only\)|Dashboard type<\/span>/);
  assert.doesNotMatch(login,/DemoPassword123!/);
  const forgot=await (await fetch(base+'/forgot-password')).text();
  assert.match(forgot,/<input type="email" name="email"/);
  const reset=await (await fetch(base+'/reset-password')).text();
  assert.match(reset,/name="token" value="" data-activation-token/);
  assert.match(reset,/name="confirmPassword"/);
  assert.match(reset,/data-activation-form hidden/);
});

test('password reset email does not silently claim success without a configured provider',async()=>{
  // The test runtime has no mail credentials and must fail closed.
  if (require('../src/config/mail').configured()) return;
  const visit=await fetch(base+'/forgot-password');
  const html=await visit.text();
  const cookie=visit.headers.get('set-cookie')?.split(';')[0];
  const token=html.match(/name="_csrf" value="([a-f0-9]{64})"/)[1];
  const response=await fetch(base+'/forgot-password',{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({_csrf:token,email:'person@example.com'}).toString()});
  assert.equal(response.status,503);
  assert.match(await response.text(),/email is temporarily unavailable/);
});
