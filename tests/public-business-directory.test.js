'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const ejs=require('ejs');
const Tenant=require('../src/platform/models/Tenant');
const directory=require('../src/platform/services/businessDirectory.service');
const seo=require('../src/config/seo');
const root=path.join(__dirname,'..');
const file=p=>fs.readFileSync(path.join(root,p),'utf8');

test('Only an owner-published snapshot can become a public business listing',()=>{
  const payload={name:'Lual Finance',headline:'Mobile money and exchange',country:'South Sudan',
    subtitle:'Operating in Juba',services:['Mobile Money','Forex'],supportPhone:'+211900000000',
    ownerEmail:'private@company.test',balance:12000000,staff:[{name:'Secret'}]};
  const snap=directory.publicSnapshot(payload,new Date('2026-11-20T00:00:00.000Z'));
  assert.equal(snap.name,payload.name);
  assert.deepEqual(snap.services,['Mobile Money','Forex']);
  assert.equal('ownerEmail' in snap,false);
  assert.equal('balance' in snap,false);
  assert.equal('staff' in snap,false);
  assert.equal(directory.publicSnapshot({name:'',headline:'x'}),null);
  const card=directory.card({slug:'lual-finance',directory:snap,email:'private@company.test',owner:'Private'});
  assert.equal(card.slug,'lual-finance');
  assert.equal(card.country,'South Sudan');
  assert.equal('email' in card,false);
  assert.equal('owner' in card,false);
  assert.ok(Tenant.schema.path('directory')?.schema?.path('publishedAt'));
});
test('Filters are bounded, safe and have stable defaults',()=>{
  assert.deepEqual(directory.normalize({q:' Mobile Money ',page:'2',sort:'name',country:'Uganda',service:'Forex'}),
    {q:'Mobile Money',country:'Uganda',service:'Forex',page:2,sort:'name'});
  assert.equal(directory.normalize({page:'999999',sort:'bad'}).page,50);
  assert.equal(directory.normalize({q:'a'.repeat(1000)}).q.length,80);
  assert.equal(directory.normalize({q:{$ne:null},service:['foo']}).q,'');
});
test('Homepage contains live card slider before unchanged Why section; no invented business fixtures',()=>{
  const html=file('src/views/original/home.ejs');
  assert(html.indexOf('id="business-profile"')>0);
  assert(html.indexOf('id="business-profile"')<html.indexOf('id="why"'));
  assert(html.includes('featuredBusinesses.forEach(business'));
  assert(html.includes("include('../partials/business-card'"));
  assert(html.includes('id="businessCardsTrack"'));
  assert(html.includes('href="/businesses"'));
  assert(html.includes('/js/business-directory.js'));
  assert.doesNotMatch(html,/Meet ClassicFin Hub/);
});
test('Directory supports functional GET filters, paging, links and escapes tenant data',async()=>{
  const fake={slug:'public-test',name:'Test & Sons <script>alert(1)</script>',
    headline:'Funds <script>evil</script>',subtitle:'Description',services:['Forex'],
    country:'Uganda',supportPhone:'+256700000000'};
  const data={directory:{filters:{q:'',country:'',service:'',sort:'recent',page:1},
    businesses:[fake],total:1,pages:1,countries:['Uganda'],services:['Forex']}};
  const html=await ejs.renderFile(path.join(root,'src/views/public/businesses.ejs'),{data});
  assert.match(html,/method="get" action="\/businesses"/);
  assert.match(html,/name="country"/);
  assert.match(html,/name="service"/);
  assert.match(html,/name="sort"/);
  assert.match(html,/href="\/t\/public-test"/);
  assert(!html.includes('<script>alert(1)</script>'));
  assert(!html.includes('<script>evil</script>'));
});
test('Individual public profile uses only owner-published fields and no placeholder contacts',async()=>{
  const data={tenant:{name:'Private legal account'},landing:{
    name:'Published Finance',headline:'Payments and exchange',subtitle:'Public intro',
    country:'Uganda',services:['Forex','Mobile Money'],sections:[{name:'About',description:'Open daily'}],
    supportPhone:'+256700000000',primary:'#082c52',secondary:'#0d4f91'}};
  const html=await ejs.renderFile(path.join(root,'src/views/public/tenant-landing.ejs'),{data});
  assert.match(html,/Published Finance/);
  assert.match(html,/Business services/);
  assert.match(html,/href="tel:\+256700000000"/);
  assert.doesNotMatch(html,/Private legal account/);
  assert.doesNotMatch(html,/fake review|5\.0 stars|sample data/i);
});
test('Directory and its live route have canonical search metadata and no private tenant indexing by default',()=>{
  assert(seo.INDEXABLE_PATHS.includes('/businesses'));
  assert(!seo.INDEXABLE_PATHS.includes('/business-profile'));
  assert(!seo.INDEXABLE_PATHS.includes('/t/example'));
  const meta=seo.publicMetadata('/businesses','Businesses on ClassicFin Hub');
  assert(meta.indexable);
  assert.match(meta.description,/real businesses/i);
  const routes=file('src/routes.public.js');
  assert.match(routes,/router\.get\('\/businesses'/);
  assert.match(routes,/res\.redirect\(308,'\/businesses'\)/);
  assert.match(routes,/businessDirectory\.service/);
});
