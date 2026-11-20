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
    {q:'Mobile Money',country:'Uganda',service:'Forex',category:'',page:2,sort:'name'});
  assert.equal(directory.normalize({page:'999999',sort:'bad'}).page,50);
  assert.equal(directory.normalize({q:'a'.repeat(1000)}).q.length,80);
  assert.equal(directory.normalize({q:{$ne:null},service:['foo']}).q,'');
});
test('Homepage contains live card slider before unchanged Why section; no invented business fixtures',()=>{
  const html=file('src/views/original/home.ejs');
  assert(html.indexOf('id="business-profile"')>0);
  assert(html.indexOf('id="business-profile"')<html.indexOf('id="why"'));
  assert(html.includes('__publishedBusinesses.forEach(business'));
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
    businesses:[fake],total:1,pages:1,countries:['Uganda'],services:['Forex'],categories:[]}};
  const html=await ejs.renderFile(path.join(root,'src/views/public/businesses.ejs'),{data});
  assert.match(html,/method="get" action="\/businesses"/);
  assert.match(html,/name="country"/);
  assert.match(html,/name="service"/);
  assert.match(html,/name="category"/);
  assert.match(html,/name="sort"/);
  assert.match(html,/href="\/t\/public-test"/);
  assert(!html.includes('<script>alert(1)</script>'));
  assert(!html.includes('<script>evil</script>'));
});
test('Individual public profile uses only owner-published fields and no placeholder contacts',async()=>{
  const data={tenant:{name:'Private legal account',slug:'published-finance'},landing:{
    name:'Published Finance',headline:'Payments and exchange',subtitle:'Public intro',
    country:'Uganda',services:['Forex','Mobile Money'],sections:[{name:'About',description:'Open daily'}],
    supportPhone:'+256700000000',primary:'#082c52',secondary:'#0d4f91'}};
  const html=await ejs.renderFile(path.join(root,'src/views/public/tenant-landing.ejs'),{data,csrfToken:'testing-csrf',assetVersion:'test'});
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


test('Only published or platform-approved active businesses have safe directory cards',()=>{
  const card=directory.card({slug:'live-tenant',name:'Live Tenant Business',status:'active',
    owner:'Private Owner',email:'private@example.com',phone:'+211123456789',directory:{}});
  assert.equal(card.slug,'live-tenant');
  assert.equal(card.name,'Live Tenant Business');
  assert.equal(card.isPublished,false);
  assert.equal(card.supportPhone,'');
  assert.deepEqual(card.services,[]);
  assert.equal(card.country,'');
  assert.equal('owner' in card,false);
  assert.equal('email' in card,false);
  assert.equal('phone' in card,false);
  const source=file('src/platform/services/businessDirectory.service.js');
  assert.match(source,/const eligible = Object.freeze/);
  assert.match(source,/status:\{\$in:\['active','trial'\]\}/);
  assert.match(source,/setupStatus:\{\$ne:'invited'\}/);
  assert.match(source,/Tenant\.find\(eligible\)/);
  assert.doesNotMatch(source,/Tenant\.find\(published\)/);
  const allowed=directory.listingFilter();
  assert.equal(allowed['directoryListing.visibility'].$ne,'hidden');
  assert(allowed.$or.some(rule=>rule['directoryListing.visibility']==='published'));
  assert(allowed.$or.some(rule=>rule['directory.publishedAt']));
  assert.match(source,/query\.\$and=\[\{\$or:/);
  const routes=file('src/routes.public.js');
  assert.match(routes,/tenant\.directoryListing\?\.visibility!=='published'/);
  const adminRoutes=file('src/platform/routes/index.js');
  assert(adminRoutes.includes("'/tenants/:id/public-listing'"));
});

test('Directory and tenant profiles share exact existing homepage footer and capsule buttons',()=>{
  const home=file('src/views/original/home.ejs');
  const layout=file('src/views/layouts/public.ejs');
  const footer=file('src/views/partials/marketing-footer.ejs');
  const style=file('public/css/style.css');
  const directoryStyle=file('public/css/business-directory.css');
  const tenantProfile=file('src/views/public/tenant-landing.ejs');
  assert(home.includes("include('../partials/marketing-footer'"));
  assert(layout.includes("include('../partials/marketing-footer'"));
  assert(footer.includes('class="footer-inner"'));
  assert(footer.includes('class="footer-note"'));
  assert(!layout.includes('class="publicContactLinks"'));
  assert.match(style,/\.btn\{min-height:50px;border-radius:999px/);
  assert(directoryStyle.includes('.businessCardPrimary.btn'));
  assert(!tenantProfile.includes('class="publicBusinessContact"'));
});


test('Platform publication requires verified admin, reason and revision',()=>{
 const admin=require('../src/platform/services/tenantAdmin.service');
 assert.deepEqual(admin.validateDirectoryListing({action:'publish',reason:'Owner has approved the public business card',revision:'0'}),
   {action:'publish',reason:'Owner has approved the public business card',revision:0});
 assert.throws(()=>admin.validateDirectoryListing({action:'publish',reason:'Too short',revision:'0'}),{status:400});
 assert.throws(()=>admin.validateDirectoryListing({action:'publish',reason:'A valid publication explanation',revision:'-1'}),{status:409});
 assert.throws(()=>admin.validateDirectoryListing({action:'publish',reason:'A valid publication explanation',revision:'0',role:'admin'}),{status:400});
 const schema=Tenant.schema.path('directoryListing')?.schema;
 assert(schema?.path('visibility'));
 assert.deepEqual(schema.path('visibility').enumValues,['default','published','hidden']);
 const show=file('src/views/platform/tenants/show.ejs');
 assert(show.includes('name="action" value="<%= directoryAction %>"'));
 assert(show.includes('name="revision"'));
 assert(show.includes('name="_csrf"'));
});
