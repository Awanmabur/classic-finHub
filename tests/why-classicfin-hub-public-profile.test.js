'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const createApp=require('../src/app');
const seo=require('../src/config/seo');
const root=path.join(__dirname,'..');
const file=p=>fs.readFileSync(path.join(root,p),'utf8');

test('Why ClassicFin Hub is an indexed public page with canonical metadata and breadcrumb',()=>{
 assert(seo.INDEXABLE_PATHS.includes('/why-classicfin-hub'));
 const meta=seo.publicMetadata('/why-classicfin-hub','Why ClassicFin Hub');
 assert.match(meta.title,/Why ClassicFin Hub/);
 assert.match(meta.description,/branch controls/i);
 assert(meta.indexable);
 assert(meta.graph['@graph'].some(x=>x['@type']==='BreadcrumbList'));
 assert(seo.llmsTxt().includes('/why-classicfin-hub')||!require('../src/config/env').indexingEnabled);
});
test('Public profile follows four-per-desktop/two-per-phone academy pattern without invented stats',()=>{
 const html=file('src/views/public/why-classicfin-hub.ejs');
 const css=file('public/css/why-classicfin-hub.css');
 assert.match(html,/<h1>Why <span>ClassicFin Hub<\/span><\/h1>/);
 assert.match(html,/class="whyProfileHighlights"/);
 assert.match(html,/>4<\/b>/);
 assert.match(css,/grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
 assert.match(css,/@media\(max-width:1050px\)/);
 assert.match(css,/\.whyProfileHighlights\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
 assert.match(html,/\/images\/bg.webp/);
 assert.match(html,/Loan Management <small>Coming soon<\/small>/);
 assert.match(html,/Provider integrations and external settlements must be verified separately/);
});
test('Public profile is navigable and all calls to action go to real routes or approved contacts',()=>{
 const html=file('src/views/public/why-classicfin-hub.ejs');
 const home=file('src/views/original/home.ejs');
 const nav=file('src/views/layouts/public.ejs');
 assert(home.includes('href="/why-classicfin-hub"'));
 assert(nav.includes('href="/why-classicfin-hub"'));
 for(const target of ['href="/#book"','href="/services"','href="https://wa.me/256781977217"','href="mailto:info@classictechgroup.com"']){
  assert(html.includes(target),target);
 }
 assert(!/\bhref="#"\b|lorem ipsum|placeholder/i.test(html));
});
test('Why ClassicFin Hub page works end-to-end with the app, its style, sitemap and trailing slash redirect',async()=>{
 const server=createApp().listen(0);
 await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  let response=await fetch(base+'/why-classicfin-hub');
  assert.equal(response.status,200);
  let body=await response.text();
  assert.match(body,/Why ClassicFin Hub/);
  assert.match(body,/Book a business demo/);
  assert.match(body,/\/css\/why-classicfin-hub.css/);
  assert.match(body,/\/images\/classicfinhub-logo.png/);
  response=await fetch(base+'/css/why-classicfin-hub.css');
  assert.equal(response.status,200);
  response=await fetch(base+'/why-classicfin-hub/',{redirect:'manual'});
  assert.equal(response.status,308);
  assert.match(response.headers.get('location')||'',/why-classicfin-hub/);
  response=await fetch(base+'/sitemap.xml');
  const sitemap=await response.text();
  if(require('../src/config/env').indexingEnabled)assert(sitemap.includes('/why-classicfin-hub'));
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('New business profile does not introduce a loan module entitlement or touch cash-first settlement logic',()=>{
 const store=require('../src/data/store');
 assert(!store.modules.some(m=>/loan/i.test(m.key)));
 const html=file('src/views/public/why-classicfin-hub.ejs');
 assert.match(html,/not currently available or billable/);
 assert(file('src/tenant/services/momoFxSettlement.service.js').includes('deposit_cash_send_provider'));
});
