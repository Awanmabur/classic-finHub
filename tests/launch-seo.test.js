'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const seo=require('../src/config/seo'),createApp=require('../src/app'),env=require('../src/config/env');
const productionEnv=()=>({...process.env,NODE_ENV:'production',APP_URL:'https://fin.example',TRUST_PROXY:'1',SEO_INDEXING_ENABLED:'true',SESSION_SECRET:crypto.randomBytes(48).toString('hex'),MFA_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex')});
function productionResult(script){const result=spawnSync(process.execPath,['-e',script],{cwd:require('node:path').join(__dirname,'..'),env:productionEnv(),encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
let server,base;
test.before(async()=>{server=await new Promise(resolve=>{const value=createApp().listen(0,()=>resolve(value));});base='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));});
test('published public crawler resources enumerate only indexable pages and apply to AI/search crawlers',()=>{
 const {robots,sitemap,llms,paths}=productionResult("const s=require('./src/config/seo');process.stdout.write(JSON.stringify({robots:s.robotsTxt(),sitemap:s.sitemapXml(),llms:s.llmsTxt(),paths:s.INDEXABLE_PATHS}))");
 assert.match(robots,/User-agent: \*\nAllow: \//);
 for(const path of ['/platform','/tenant','/t/','/integrations','/mfa','/accept-invite','/reset-password','/health'])assert(robots.includes('Disallow: '+path),path);
 assert(robots.includes('Sitemap: https://fin.example/sitemap.xml'));
 const locations=[...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match=>new URL(match[1]));
 assert.equal(locations.length,paths.length);assert.equal(new Set(locations.map(location=>location.href)).size,paths.length);
 for(const location of locations){assert.equal(location.origin,'https://fin.example');assert(paths.includes(location.pathname));assert(!location.search);}
 for(const forbidden of ['/signin','/signup','/t/','/tenant','/platform','/integrations','/health','/mfa'])assert(!locations.some(location=>location.pathname.startsWith(forbidden)),forbidden);
 assert.match(llms,/Product guide.*product-guide/);assert.match(llms,/current published subscription terms/);assert.match(llms,/do not establish live provider balances/);
 assert.doesNotMatch(llms,/https:\/\/fin\.example\/(tenant|platform|t\/|integrations|mfa)/);
 assert.doesNotMatch(sitemap,/<lastmod>/,'do not invent content revision dates');
});
test('every advertised public URL returns canonical HTML with social metadata, crawlable content and valid nonce JSON-LD',async()=>{
 for(const path of seo.INDEXABLE_PATHS){
  const response=await fetch(base+path);assert.equal(response.status,200,path);const html=await response.text();
  assert(html.includes('rel="canonical" href="'+env.appUrl+path+'"'),path);assert.match(html,/<h1(?:\s|>)/,path);assert.match(html,/property="og:title"/);assert.match(html,/name="twitter:description"/);
  const match=html.match(/<script type="application\/ld\+json" nonce="([^"]+)">([\s\S]*?)<\/script>/);assert(match,path);const graph=JSON.parse(match[2]);assert.equal(graph['@context'],'https://schema.org');assert(response.headers.get('content-security-policy').includes("'nonce-"+match[1]+"'"));
  assert(!JSON.stringify(graph).includes('aggregateRating'),'no invented ratings');
 }
 const guide=await fetch(base+'/product-guide?utm_source=sample');const html=await guide.text();assert(html.includes('href="'+env.appUrl+'/product-guide"'));assert.doesNotMatch(html,/rel="canonical"[^>]*utm_source/);
 assert.match(html,/SoftwareApplication/);assert.match(html,/configured wallet/);assert.match(html,/do not establish live provider balances/);
});
test('marketing aliases redirect to one case-sensitive canonical URL and staging does not advertise indexing',async()=>{
 for(const [path,canonical]of [['/ABOUT?campaign=demo','/about?campaign=demo'],['/marketplace/','/marketplace'],['/PRODUCT-GUIDE','/product-guide']]){
  const response=await fetch(base+path,{redirect:'manual'});assert.equal(response.status,308,path);assert.equal(response.headers.get('location'),canonical);
 }
 if(!env.indexingEnabled){assert.equal(seo.robotsTxt(),'User-agent: *\nDisallow: /\n');assert.doesNotMatch(seo.sitemapXml(),/<loc>/);assert.match(seo.llmsTxt(),/indexing disabled/);}
});
test('production catalogue outage never substitutes seeded prices and public JSON-LD escapes script delimiters',()=>{
 const result=productionResult("require('./src/platform/services/publicPlans.service').publicPlans().then(value=>process.stdout.write(JSON.stringify(value)))");
 assert.equal(result.unavailable,true);assert.equal(result.persisted,true);assert.deepEqual(result.plans,[]);
 const original={name:'</script><script>alert(1)</script>&\u2028\u2029'},encoded=seo.jsonLd(original);assert.doesNotMatch(encoded,/<|>|&|\u2028|\u2029/);assert.deepEqual(JSON.parse(encoded),original);
});
test('homepage and guide describe actual workflows without fabricated testimonials or obsolete product promises',async()=>{
 const home=await(await fetch(base+'/')).text(),faq=await(await fetch(base+'/faq')).text();
 assert.doesNotMatch(home,/Our branch team|alt="Tenant admin"|alt="Operations manager"|alt="Finance officer"|Pricing starts from USD \$29/);
 assert.match(home,/data-plan-code=/);assert.match(home,/published plan catalogue/);assert.match(home,/href="\/product-guide"/);
 assert.doesNotMatch(faq,/PDF, CSV, Excel|scheduled email|create an invoice when paid/);assert.match(faq,/CSV exports and browser printing/);
});
