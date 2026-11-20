'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');
const workspace=require('../src/tenant/workspace/service');
const reviews=require('../src/platform/services/businessReviews.service');
const seo=require('../src/config/seo');
const Review=require('../src/platform/models/BusinessReview');
const Tenant=require('../src/platform/models/Tenant');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

function input(override={}){return {headline:'Built on local trust',subtitle:'Visit our team',services:'Forex,Mobile Money',
  category:'Financial services',about:'A Juba business serving local customers',
  city:'Juba',region:'Central Equatoria',address:'Town center',
  publicEmail:'support@example.com',website:'https://example.com',whatsapp:'+211900000000',
  hours:'Mon–Sat 08:00–18:00',facebook:'https://facebook.com/example',instagram:'',
  linkedin:'',logoUrl:'https://example.com/logo.webp',coverUrl:'https://example.com/cover.webp',
  gallery:'https://example.com/1.webp\nhttps://example.com/2.webp',...override};}
test('Tenant can save rich structured business website details without publishing owner credentials',()=>{
 const parsed=workspace.validateConfig('landing',input());
 assert.equal(parsed.headline,'Built on local trust');
 assert.deepEqual(parsed.services,['Forex','Mobile Money']);
 assert.equal(parsed.details.city,'Juba');
 assert.equal(parsed.details.gallery.length,2);
 assert.equal(parsed.details.publicEmail,'support@example.com');
 assert.equal('ownerEmail' in parsed.details,false);
 const schema=require('../src/tenant/workspace/models').configSchema;
 assert(schema.path('landing')?.schema?.path('details'));
 assert(schema.path('landing')?.schema?.path('published')?.schema?.path('details'));
});
test('Unsafe schemes, private hosts, duplicate gallery URLs and oversized business fields fail validation',()=>{
 for(const bad of ['javascript:alert(1)','http://example.com','https://localhost/x','https://127.0.0.1/x','https://private.local/image'])
  assert.throws(()=>workspace.validateConfig('landing',input({logoUrl:bad})),{status:400},bad);
 assert.throws(()=>workspace.validateConfig('landing',input({gallery:'https://example.com/1.webp,https://example.com/1.webp'})),{status:400});
 assert.throws(()=>workspace.validateConfig('landing',input({about:'a'.repeat(3001)})),{status:400});
 assert.throws(()=>workspace.validateConfig('landing',input({ownerEmail:'private@company.com'})),{status:400});
});
test('Public reviews validate rating, human name, text and reject injected form fields',()=>{
 assert.deepEqual(reviews.reviewFields({authorName:'Grace',rating:'4',comment:'The service team helped promptly.',website:''}),{
  authorName:'Grace',rating:4,comment:'The service team helped promptly.'});
 assert.throws(()=>reviews.reviewFields({authorName:'G',rating:'6',comment:'This comment is adequate.'}),{status:400});
 assert.throws(()=>reviews.reviewFields({authorName:'Grace',rating:3,comment:'too short'}),{status:400});
 assert.throws(()=>reviews.reviewFields({authorName:'Grace',rating:3,comment:'This is my review, thank you',ownerEmail:'private@x.test'}),{status:400});
 assert.match(reviews.cookieName('published-finance'),/^cfhr_[a-f0-9]{16}$/);
 assert.equal(Review.schema.path('tokenHash').options.select,false);
 assert.equal(Review.schema.path('networkHash').options.select,false);
});
test('Only owner-published business pages qualify for organic indexing, with no invented rating-rich-results',()=>{
 const tenant={slug:'juba-business',name:'Business',directoryListing:{visibility:'published'}};
 const publicLanding={name:'Juba Business',headline:'Helping in Juba',subtitle:'Financial services near the market',
  details:{city:'Juba',publicEmail:'support@example.com',website:'https://example.com'}};
 const minimal=seo.tenantMetadata(tenant,publicLanding);
 assert.equal(minimal.indexable,false);
 const published=seo.tenantMetadata(tenant,{...publicLanding,publishedAt:new Date('2026-11-20')});
 assert.equal(published.indexable,true);
 assert.match(published.canonical,/\/t\/juba-business$/);
 assert.match(published.description,/Financial services/);
 assert(!JSON.stringify(published.graph).includes('aggregateRating'));
 const hidden=seo.tenantMetadata({...tenant,directoryListing:{visibility:'hidden'}},{...publicLanding,publishedAt:new Date()});
 assert.equal(hidden.indexable,false);
 assert(!seo.PRIVATE_PREFIXES.includes('/t/'));
 assert(seo.PRIVATE_PREFIXES.includes('/t/*/my-review'));
});
test('Public business website escapes untrusted text and shows real contact, ratings and available services',async()=>{
 const data={tenant:{slug:'juba-business',name:'Internal private tenant name'},
  landing:{name:'Juba Business',headline:'Better <script>alert(1)</script> services',
   subtitle:'Working for you',country:'South Sudan',
   details:{category:'Financial services',about:'We have worked here for years.',
    address:'Juba Road',city:'Juba',region:'Central Equatoria',publicEmail:'info@example.com',
    website:'https://example.com/',hours:'Mon–Sat 08:00–18:00',
    whatsapp:'+211900000000',logoUrl:'https://example.com/logo.webp',
    coverUrl:'https://example.com/cover.webp',gallery:['https://example.com/photo.webp']},
   services:['Forex','Mobile Money'],sections:[{name:'About us',description:'Public published details'}],
   publishedAt:new Date('2026-11-20'),supportPhone:'+211999999999'},
  reviews:{rows:[{authorName:'Customer <script>bad()</script>',rating:4,
    comment:'Useful service and clear communication.',ownerReply:'Thank you!'}],summary:{count:1,avg:4}},
  myReview:{authorName:'Grace'}};
 const html=await ejs.renderFile(path.join(__dirname,'../src/views/public/tenant-landing.ejs'),
   {data,csrfToken:'test-csrf',assetVersion:'test'});
 for(const marker of ['Juba Business','Our expertise','Photo gallery','Opening hours',
   'Customer ratings & reviews','Share your experience','name="_csrf" value="test-csrf"',
   'https://example.com/cover.webp','href="mailto:info@example.com"'])assert(html.includes(marker),marker);
 assert(!html.includes('<script>alert(1)</script>'));
 assert(!html.includes('<script>bad()</script>'));
 assert(!html.includes('Internal private tenant name'));
});
test('Owner publishing and moderation routes are wired to persistent services with CSRF and approval controls',()=>{
 const publicRoutes=read('src/routes.public.js');
 const platformRoutes=read('src/platform/routes/index.js');
 const tenantRoutes=read('src/tenant/workspace/routes.js');
 const csrf=read('src/middleware/csrfProtection.js');
 assert(publicRoutes.includes("router.post('/t/:slug/reviews'"));
 assert(publicRoutes.includes("router.get('/t/:slug/my-review'"));
 assert(platformRoutes.includes("router.post('/business-reviews/:id/moderate'"));
 assert(tenantRoutes.includes("router.post('/reviews/:id/reply'"));
 assert(csrf.includes("my-review"));
 assert(read('src/views/platform/business-reviews/index.ejs').includes('name="action"'));
 assert(read('src/views/tenant/workspace/reviews.ejs').includes('name="reply"'));
 assert(Tenant.schema.path('directory')?.schema?.path('logoUrl'));
});
