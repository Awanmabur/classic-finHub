'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const createApp = require('../src/app');
const mfa = require('../src/platform/services/mfa.service');

// Isolated per-test encryption key; never create or expose actual administrator secrets.
const KEY = crypto.randomBytes(32).toString('hex');
test('TOTP enrollment secrets are encrypted, tamper resistant and never reused', () => {
  const before = process.env.MFA_ENCRYPTION_KEY;
  try {
    process.env.MFA_ENCRYPTION_KEY = KEY;
    const secret=mfa.generateSecret();
    assert.match(secret,/^[A-Z2-7]{32}$/);
    const sealed=mfa.encryptSecret(secret);
    assert(!sealed.includes(secret));
    assert.equal(mfa.decryptSecret(sealed),secret);
    const counter=1234567;
    const code=mfa.counterCode(secret,counter);
    assert.match(code,/^\d{6}$/);
    const now=counter*30000+12500;
    assert.equal(mfa.verifyCode(secret,code,-1,now),counter);
    assert.equal(mfa.verifyCode(secret,code,counter,now),null,'must reject replay');
    assert.equal(mfa.verifyCode(secret,code,-1,now+90000),null,'must reject expired codes');
    const changed=sealed.split('.');
    changed[2]=Buffer.from('modified ciphertext').toString('base64url');
    assert.throws(()=>mfa.decryptSecret(changed.join('.')));
  } finally { if (before === undefined) delete process.env.MFA_ENCRYPTION_KEY; else process.env.MFA_ENCRYPTION_KEY=before; }
});
test('Administrator MFA pending sessions expire and enforce attempt cap',()=>{
  const now=Date.now();
  const req={session:{pendingMfa:{platformId:'p',identityId:'i',authVersion:0,startedAt:now,attempts:0}}};
  assert(mfa.pendingSession(req));
  req.session.pendingMfa.startedAt=now-mfa.PENDING_MS-100;
  assert.equal(mfa.pendingSession(req),null);
  const state={attempts:0};
  for(let i=0;i<mfa.MAX_ATTEMPTS;i++) mfa.recordAttempt(state);
  assert.throws(()=>mfa.recordAttempt(state),e=>e.status===429);
});
test('Production crawler rules allow public pages and do not advertise private URLs',()=>{
  const exec=spawnSync(process.execPath,['-e',"process.stdout.write(JSON.stringify(require('./src/config/seo')))"] ,{
    cwd:require('node:path').join(__dirname,'..'),
    env:{...process.env,NODE_ENV:'production',APP_URL:'https://fin.example',TRUST_PROXY:'1',SEO_INDEXING_ENABLED:'true',SESSION_SECRET:'z'.repeat(64),MFA_ENCRYPTION_KEY:KEY},encoding:'utf8'
  });
  assert.equal(exec.status,0,exec.stderr);
  // JSON.stringify skips functions, so re-run their results in a separate child.
  const page=spawnSync(process.execPath,['-e',"const s=require('./src/config/seo');process.stdout.write(JSON.stringify({robots:s.robotsTxt(),sitemap:s.sitemapXml(),llms:s.llmsTxt()}))"],{
    cwd:require('node:path').join(__dirname,'..'),env:{...process.env,NODE_ENV:'production',APP_URL:'https://fin.example',TRUST_PROXY:'1',SEO_INDEXING_ENABLED:'true',SESSION_SECRET:'z'.repeat(64),MFA_ENCRYPTION_KEY:KEY},encoding:'utf8'
  });
  assert.equal(page.status,0,page.stderr);
  const {robots,sitemap,llms}=JSON.parse(page.stdout);
  assert.match(robots,/Disallow: \/tenant/);
  assert.match(robots,/Disallow: \/mfa/);
  assert.match(robots,/Sitemap: https:\/\/fin\.example\/sitemap\.xml/);
  assert.match(sitemap,/<loc>https:\/\/fin\.example\/pricing<\/loc>/);
  assert.doesNotMatch(sitemap,/(signin|tenant|mfa|health)/);
  assert.match(llms,/pricing/);
  assert.doesNotMatch(llms,/https:\/\/fin\.example\/tenant/);
});
let server,base;
test.before(async()=>{await new Promise(resolve=>{server=createApp().listen(0,resolve)});base=`http://127.0.0.1:${server.address().port}`;});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));});
test('Indexable marketing pages contain their own canonical, social metadata and parseable structured data',async()=>{
  for(const path of ['/','/about','/pricing','/faq','/privacy']){
    const res=await fetch(base+path);assert.equal(res.status,200,path);
    const html=await res.text();
    assert.match(html,new RegExp('rel="canonical" href="http://localhost:3000'+(path==='/'?'/':path)+'"'));
    assert.match(html,/property="og:title"/);
    assert.match(html,/property="og:image"/);
    const match=html.match(/<script type="application\/ld\+json" nonce="([^"]+)">([\s\S]*?)<\/script>/);
    assert(match,`No JSON-LD for ${path}`);
    const schema=JSON.parse(match[2]);assert.equal(schema['@context'],'https://schema.org');
    const csp=res.headers.get('content-security-policy');
    assert(csp.includes(`'nonce-${match[1]}'`),'structured data nonce must match CSP');
    assert.match(res.headers.get('cache-control'),/no-store/);
  }
});
test('Crawlers cannot index private pages, MFA endpoints or tenant landing pages',async()=>{
  for(const path of ['/signin','/mfa/setup','/mfa/challenge','/tenant/dashboard','/platform/dashboard','/t/no-such-tenant']){
    const res=await fetch(base+path,{redirect:'manual'});
    assert.match(res.headers.get('x-robots-tag'),/noindex/,path);
    assert.match(res.headers.get('cache-control'),/no-store/,path);
  }
});
test('Tenant landing pages fail promptly when MongoDB is disconnected',async()=>{
  const started=Date.now();
  const res=await fetch(base+'/t/unknown-tenant');
  assert.equal(res.status,503);
  assert.match(res.headers.get('x-robots-tag'),/noindex/);
  assert.match(res.headers.get('cache-control'),/no-store/);
  assert(Date.now()-started < 1500,'database outage should not stall public requests');
});
test('Public images use compressed WebP with cache headers and dashboard CSS remains served',async()=>{
  const image=await fetch(base+'/images/bg.webp');
  assert.equal(image.status,200);
  assert.match(image.headers.get('content-type'),/image\/webp/);
  assert.match(image.headers.get('cache-control'),/max-age=604800/);
  const dashboard=await fetch(base+'/css/dashboard.css');
  assert.equal(dashboard.status,200);
  assert(dashboard.headers.get('etag'));
  const robots=await fetch(base+'/robots.txt');
  assert.match(await robots.text(),/Disallow: \/|Sitemap:/);
  assert.equal(robots.headers.get('x-request-id')?.length,36);
  const llms=await fetch(base+'/llms.txt');assert.equal(llms.status,200);
});
test('Rate-limit bucket keys are tenant scoped and do not contain raw principal IDs',()=>{
  const { throttleKey }=require('../src/platform/services/actionThrottle.service');
  const key=throttleKey('money-user','tenant-a:user-1',60000,180000);
  assert(!key.includes('tenant-a'));
  assert(!key.includes('user-1'));
  assert.notEqual(key,throttleKey('money-user','tenant-b:user-1',60000,180000));
  assert.notEqual(key,throttleKey('money-user','tenant-a:user-1',60000,240000));
});
