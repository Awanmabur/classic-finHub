#!/usr/bin/env node
'use strict';
// This fixture exercises the authenticated MFA challenge flow explicitly.
process.env.MFA_ENABLED='true';
// Destructive checks are confined to random scratch databases on one loopback
// replica set. Never run against production or a remote MongoDB deployment.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Workspace integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),database=`cfh_workspace_probe_${nonce}`,slugs=[`probe-ws-a-${nonce}`,`probe-ws-b-${nonce}`];
configured.pathname='/'+database;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';process.env.MFA_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');
const mongoose=require('mongoose'),bcrypt=require('bcryptjs'),expressSession=require('express-session');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const models=require('../src/tenant/models'),service=require('../src/tenant/workspace/service'),workspace=require('../src/tenant/workspace/models');
const Tenant=require('../src/platform/models/Tenant'),Identity=require('../src/platform/models/AccountIdentity'),commerce=require('../src/platform/services/commercial.service');
const mfa=require('../src/platform/services/mfa.service'),createApp=require('../src/app');
const tenantAdmin=require('../src/platform/services/tenantAdmin.service');
let connections=[],server;
const profile=(name='Workspace business')=>({name,legalName:'Workspace Business Limited',owner:'Owner',ownerEmail:'owner@example.invalid',supportPhone:'+256700123456',country:'Uganda',timezone:'Africa/Kampala',defaultCurrency:'UGX'});
const brand={theme:'Approved theme',primary:'#123456',secondary:'#345678',logoStatus:'Not uploaded',receiptNote:'Saved receipt footer',prefix:'WS',template:'Tenant receipt'};
const csrf=html=>{const found=html.match(/name="_csrf" value="([a-f0-9]{64})"/);assert(found,'CSRF token is rendered');return found[1];};
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 for(const model of [Tenant,Identity,require('../src/platform/models/LoginThrottle'),require('../src/platform/models/SecurityEvent')])await model.createIndexes();
 await require('../src/platform/models/PlatformAuditLog').createCollection();
 connections=slugs.map(getTenantConnection);await Promise.all(connections.map(models.ensureTenantIndexes));
 const plan=commerce.planSnapshot({...commerce.asPlanVersion(require('../src/data/store').plans.find(p=>p.code==='agent')),status:'published'});
 const tenants=[];for(let i=0;i<2;i++)tenants.push(await Tenant.create({name:`Workspace ${i}`,slug:slugs[i],dbName:connections[i].name,owner:'Workspace Owner',email:`ws-${i}-${nonce}@example.invalid`,plan:'agent',status:'active',setupStatus:'complete',enabledModules:plan.modules,seatsReserved:2,branchCount:0,subscription:{...plan,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}}));
 const password='Workspace-Integration#2026',hash=await bcrypt.hash(password,12),secret=mfa.generateSecret();
 const owners=[];for(let i=0;i<2;i++){const person=await models.tenantUserModel(connections[i]).create({name:'Workspace Owner',email:tenants[i].email,passwordHash:hash,role:'Tenant Owner',status:'active',mfaSecretEncrypted:mfa.encryptSecret(secret),mfaEnabledAt:new Date(),mfaLastCounter:-1});await Identity.create({email:person.email,kind:'tenant',tenantId:tenants[i]._id,accountId:person._id});owners.push({id:String(person._id),role:'Tenant Owner',permissions:['*']});}
 const [conn,other]=connections,[tenant,otherTenant]=tenants,[owner,otherOwner]=owners;
 const viewer=await models.tenantUserModel(conn).create({name:'Viewer',email:`viewer-${nonce}@example.invalid`,passwordHash:hash,role:'Viewer',permissions:['*'],status:'active'});
 const forged={id:String(viewer._id),role:'Tenant Owner',permissions:['*']};
 await assert.rejects(service.read(conn,tenant,forged),{status:403},'stored fixed role overrides forged owner permissions');
 await assert.rejects(service.save(other,tenant,owner,'profile',{...profile(),revision:0}),{status:403},'wrong tenant connection is rejected before writes');
 assert.equal((await service.read(conn,tenant,owner)).revision,0);
 let saved=await service.save(conn,tenant,owner,'profile',{...profile(),revision:'0'});assert.equal(saved.revision,1);
 const auditsBefore=await models.auditEventModel(conn).countDocuments();
 await assert.rejects(service.save(conn,tenant,owner,'profile',{...profile('Stale update'),revision:'0'}),{status:409});
 assert.equal(await models.auditEventModel(conn).countDocuments(),auditsBefore,'failed stale save adds no misleading audit entry');
 const races=await Promise.allSettled(['First writer','Second writer'].map(name=>service.save(conn,tenant,owner,'profile',{...profile(name),revision:1})));
 assert.equal(races.filter(v=>v.status==='fulfilled').length,1);assert.equal(races.filter(v=>v.status==='rejected'&&v.reason.status===409).length,1);saved=await service.read(conn,tenant,owner);assert.equal(saved.revision,2);
 const Audit=models.auditEventModel(conn),originalCreate=Audit.create,tenantBefore=await Tenant.findById(tenant._id).lean(),ownerBefore=await models.tenantUserModel(conn).findById(owner.id).lean();
 try{Audit.create=async()=>{throw new Error('Injected audit write failure');};await assert.rejects(service.save(conn,tenant,owner,'branding',{...brand,revision:2}),/Injected audit write failure/);}finally{Audit.create=originalCreate;}
 assert.equal((await service.read(conn,tenant,owner)).revision,2,'audit failure rolls back settings');assert.equal((await Tenant.findById(tenant._id)).__v,tenantBefore.__v,'tenant authorization fence rolls back');assert.equal((await models.tenantUserModel(conn).findById(owner.id)).__v,ownerBefore.__v,'account authorization fence rolls back');
 saved=await service.save(conn,tenant,owner,'branding',{...brand,revision:2});assert.equal(saved.revision,3);
 // Real Mongo-backed public rate-board proof, isolated to this disposable
 // tenant database. No fake published prices or customer trading records.
 const branch=await models.branchModel(conn).create({name:'Scratch FX counter',code:'ws-fx',
  currency:'UGX',createdBy:new mongoose.Types.ObjectId(owner.id),updatedBy:new mongoose.Types.ObjectId(owner.id)});
 const Rate=models.forexRateModel(conn),at=new Date(),future=new Date(at.getTime()+3600000);
 await Rate.create([
  {branchId:branch._id,fromCurrency:'UGX',toCurrency:'SSP',side:'buy',rateDecimal:'4',
   proposedBy:owner.id,status:'active',reviewedBy:owner.id,reviewedAt:at,expiresAt:future,note:'Approved scratch business rate'},
  {branchId:branch._id,fromCurrency:'UGX',toCurrency:'SSP',side:'sell',rateDecimal:'5',
   proposedBy:owner.id,status:'active',reviewedBy:owner.id,reviewedAt:at,expiresAt:new Date(at.getTime()-60000),note:'Expired scratch rate'},
  {branchId:branch._id,fromCurrency:'UGX',toCurrency:'USD',side:'quote',rateDecimal:'0.001',
   proposedBy:owner.id,status:'pending_review',expiresAt:future,note:'Pending review price'}
 ]);
 // Agent subscription does not contain Forex. Simulate a valid licensed
 // snapshot for this isolated test without changing either tenant's grants.
 const original=tenant.toObject(),licensed={...original,
  enabledModules:[...original.enabledModules,'forex'],
  subscription:{...original.subscription,modules:[...original.subscription.modules,'forex']}};
 const publicBoard=require('../src/tenant/workspace/publicRates').publicBoard;
 const publishedRates=await publicBoard(conn,licensed);
 assert.equal(publishedRates.rates.length,1,'only reviewed, active, non-expired rates may be public');
 assert.equal(publishedRates.rates[0].base,'1,000 UGX');
 assert.equal(publishedRates.rates[0].price,'4,000');
 assert.equal(publishedRates.rates[0].timeZone,'Africa/Kampala');
 assert.equal(publishedRates.rates[0].expiresLocal,require('../src/utils/businessTime').format(future,'Africa/Kampala'));
 assert.equal(publishedRates.rates[0].branch,'Scratch FX counter');
 assert.equal((await publicBoard(conn,tenant)).rates.length,0,'unsubscribed Forex rates are not public');
 assert.equal((await publicBoard(other,licensed)).rates.length,0,'another tenant database cannot reveal our rates');

 saved=await service.save(conn,tenant,owner,'landing',{headline:'Published <script>example()</script>',subtitle:'Published customer description',services:'Mobile Money,Forex',revision:3});assert.equal(saved.revision,4);
 const published=await service.writeEntry(conn,tenant,owner,'landing_section',{name:'Published services',description:'Published body <img src=x onerror=unsafe()>',status:'published',order:'1'});
 const draft=await service.writeEntry(conn,tenant,owner,'landing_section',{name:'Private draft section',description:'Never public until published',status:'draft',order:'2'});
 const publishedResult=await service.publish(conn,tenant,owner,{revision:4});
 assert.equal(publishedResult.directorySyncPending,false,'owner publication should appear in the directory');
 const publishedDirectory=await Tenant.findById(tenant._id).lean();
 assert.equal(publishedDirectory.directory.name,publishedResult.landing.published.name);
 let landing=await service.publicLanding(conn,tenant);assert.equal(landing.sections.length,1);assert.equal(landing.sections[0].name,'Published services');
 const BusinessReview=require('../src/platform/models/BusinessReview');
 const PlatformAuditLog=require('../src/platform/models/PlatformAuditLog');
 await Promise.all([BusinessReview.createIndexes(),PlatformAuditLog.createIndexes()]);
 const approvedReview=await BusinessReview.create({tenantId:tenant._id,tenantSlug:tenant.slug,
   authorName:'Scratch reviewer',rating:4,comment:'The local service was courteous and helpful.',
   status:'approved',approvedAt:new Date(),tokenHash:crypto.randomBytes(32).toString('hex'),
   networkHash:crypto.randomBytes(32).toString('hex')});
 const reviews=require('../src/platform/services/businessReviews.service');
 await reviews.reply(conn,tenant,owner,String(approvedReview._id),{revision:0,reply:'Thank you for visiting our team.'});
 const replied=await BusinessReview.findById(approvedReview._id).lean();
 assert.equal(replied.ownerReply,'Thank you for visiting our team.');
 await assert.rejects(reviews.reply(other,otherTenant,otherOwner,String(approvedReview._id),
   {revision:1,reply:'Cross-tenant response'}),{status:409},'owners cannot respond to another tenant review');
 assert.equal(await PlatformAuditLog.countDocuments({action:'business.review.reply_updated',
   recordId:String(approvedReview._id)}),1);
 await service.save(conn,tenant,owner,'landing',{headline:'Unpublished headline',subtitle:'Private updated description',services:'Mobile Money',revision:5});assert.equal((await service.publicLanding(conn,tenant)).headline,'Published <script>example()</script>','draft changes do not alter published snapshot');
 const edited=await service.writeEntry(conn,tenant,owner,'landing_section',{name:published.name,description:'Edited source section',status:'published',order:'1',revision:0},String(published._id));assert.equal(edited.revision,1);
 await assert.rejects(service.writeEntry(conn,tenant,owner,'landing_section',{name:'Stale section',description:'Unwanted stale content',status:'published',order:'1',revision:0},String(published._id)),{status:409});
 await assert.rejects(service.transition(other,otherTenant,otherOwner,'landing_section',String(published._id),{action:'archive',revision:1}),{status:409},'another tenant cannot edit a foreign record ID');
 await service.transition(conn,tenant,owner,'landing_section',String(published._id),{action:'archive',revision:1});
 const restored=await service.transition(conn,tenant,owner,'landing_section',String(published._id),{action:'restore',revision:2});assert.equal(restored.status,'published','restore retains the previous lifecycle status');
 await service.transition(conn,tenant,owner,'landing_section',String(draft._id),{action:'archive',revision:0});assert.equal((await service.entries(conn,tenant,owner,'landing_section')).length,1);
 await service.transition(conn,tenant,owner,'landing_section',String(draft._id),{action:'restore',revision:1});assert.equal((await service.entries(conn,tenant,owner,'landing_section')).length,2);
 const job=await service.writeEntry(conn,tenant,owner,'data_job',{name:'Customer onboarding description',type:'CSV'});assert.equal(job.status,'draft');
 const rejected=await service.transition(conn,tenant,owner,'data_job',String(job._id),{action:'run',revision:0});assert.equal(rejected.status,'rejected');assert.equal(rejected.records,0);assert.match(rejected.result,/No import worker/);
 await service.writeEntry(conn,tenant,owner,'kyc_field',{name:'Passport check',type:'Select',required:'true',status:'enabled',options:'Passport,National ID',description:'Review the original document.'});
 await service.writeEntry(conn,tenant,owner,'compliance_rule',{name:'High value review',riskLevel:'High',status:'enabled',description:'Require independent operational review.'});
 await service.writeEntry(conn,tenant,owner,'notification_rule',{name:'Owner daily digest',channel:'Dashboard',status:'draft',description:'Review daily activity after closing.'});
 await service.writeEntry(conn,tenant,owner,'integration',{name:'Android gateway',type:'Messaging',status:'draft',description:'Enroll signed devices through SMS capture.'});
 await assert.rejects(service.writeEntry(conn,tenant,owner,'integration',{name:'Secret injection',type:'API',status:'enabled',description:'API key: private-value'}),{status:400});
 const exported=await service.exportConfig(conn,tenant,owner);assert.equal(exported.schemaVersion,1);assert(exported.records.length>=5);assert.doesNotMatch(JSON.stringify(exported),/passwordHash|mfaSecret|private-value|SESSION_SECRET/);
 const identity=await service.receiptIdentity(conn,tenant);assert.equal(identity.footerNote,brand.receiptNote);assert.equal(identity.primary,brand.primary);assert(!Object.hasOwn(identity,'ownerEmail'));
 const stats=await service.health(conn,tenant,owner);assert(stats.collections>0);assert(stats.objects>0);assert.equal(typeof stats.backupConfigured,'boolean');
 assert((await service.logs(conn,tenant,owner)).some(row=>row.action==='workspace.database.health_checked'));

 server=await new Promise(resolve=>{const instance=createApp({sessionStore:new expressSession.MemoryStore()}).listen(0,()=>resolve(instance));});const base=`http://127.0.0.1:${server.address().port}`;let cookie='';
 async function request(path,values){const response=await fetch(base+path,{method:values?'POST':'GET',redirect:'manual',headers:{...(cookie?{cookie}:{}),...(values?{'content-type':'application/x-www-form-urlencoded'}:{})},...(values?{body:new URLSearchParams(values).toString()}:{})});cookie=response.headers.get('set-cookie')?.split(';')[0]||cookie;return {response,html:await response.text()};}
 const publicPage=await request('/t/'+tenant.slug);assert.equal(publicPage.response.status,200,publicPage.html);assert.match(publicPage.response.headers.get('cache-control'),/no-store/);assert.match(publicPage.html,/Published &lt;script&gt;/);assert.doesNotMatch(publicPage.html,/Private draft section|Unpublished headline|<script>example\(\)/);
 // Active and fully activated tenant business names are public immediately.
 // Detailed owner profile, contacts, drafts and financial records remain private.
 const basicPage=await request('/t/'+otherTenant.slug);
 assert.equal(basicPage.response.status,200,'active tenant business is live without admin listing approval');
 assert.match(basicPage.html,/Workspace 1/);
 assert(!basicPage.html.includes(otherTenant.email),'private tenant owner email must remain hidden');
 assert(!basicPage.html.includes('Private draft section'));
 const directoryListed=await request('/businesses');
 assert.equal(directoryListed.response.status,200);
 assert(directoryListed.html.includes('/t/'+otherTenant.slug));
 await assert.rejects(service.listingVisibility(other,otherTenant,owner,{action:'hide'}),{status:403},
   'Owner of a separate tenant cannot alter this business');
 const hidden=await service.listingVisibility(other,otherTenant,otherOwner,{action:'hide'});
 assert.equal(hidden.visibility,'hidden');
 const hiddenPage=await request('/t/'+otherTenant.slug);
 assert.equal(hiddenPage.response.status,404,'owner can hide business without platform administrator');
 const directoryHidden=await request('/businesses');
 assert(!directoryHidden.html.includes('/t/'+otherTenant.slug));
 const visible=await service.listingVisibility(other,otherTenant,otherOwner,{action:'show'});
 assert.equal(visible.visibility,'default');
 assert.equal((await request('/t/'+otherTenant.slug)).response.status,200);
 assert((await require('../src/platform/models/PlatformAuditLog').countDocuments({
   action:'tenant.business_listing_visibility_changed',recordId:String(otherTenant._id)}))===2);
 const anon=await request('/tenant/workspace/profile');assert.equal(anon.response.status,303);assert.equal(anon.response.headers.get('location'),'/signin');
 const signIn=await request('/signin');await request('/signin',{email:tenant.email,password,_csrf:csrf(signIn.html)});const challenge=await request('/mfa/challenge');const verification=await request('/mfa/challenge',{code:mfa.counterCode(secret,Math.floor(Date.now()/30000)),_csrf:csrf(challenge.html)});assert.equal(verification.response.status,303,verification.html);
 for(const path of ['','/profile','/landing','/branding','/kyc','/database','/subscription','/notification-rules','/integrations','/import-export','/compliance','/landing-preview','/receipt-preview','/customer-portal-preview','/audit','/profile/edit','/branding/edit','/branding/receipt/edit','/landing/headline/edit','/entries/landing_section/new']){const page=await request('/tenant/workspace'+path);assert.equal(page.response.status,200,`${path}: ${page.html.slice(0,600)}`);assert.doesNotMatch(page.html,/passwordHash|mfaSecretEncrypted/);}
 const rolesLink=await request('/tenant/workspace/roles');
 assert.equal(rolesLink.response.status,303,'Owner role shortcut opens assigned module settings');
 assert.equal(rolesLink.response.headers.get('location'),'/tenant/users#role-module-assignments');
 const legacyControl=await request('/tenant/workspace/control');assert.equal(legacyControl.response.status,303);assert.equal(legacyControl.response.headers.get('location'),'/tenant/workspace/profile','retired phase navigation follows the profile setup guide');
 const profilePage=await request('/tenant/workspace/profile');const prior=await service.read(conn,tenant,owner);const forgedCsrf=await request('/tenant/workspace/profile',{...profile(),revision:prior.revision,_csrf:'forged'});assert.equal(forgedCsrf.response.status,403);assert.equal((await service.read(conn,tenant,owner)).revision,prior.revision);
 const updated=await request('/tenant/workspace/profile',{...profile('Saved through authenticated form'),revision:prior.revision,_csrf:csrf(profilePage.html)});assert.equal(updated.response.status,303,updated.html);assert.equal((await service.read(conn,tenant,owner)).profile.name,'Saved through authenticated form');
 const css=await request('/tenant/workspace/theme.css');assert.equal(css.response.status,200);assert.match(css.response.headers.get('content-type'),/text\/css/);assert.match(css.html,/--primary:#123456/);assert.doesNotMatch(css.html,/<script|owner@example/);
 // R2 media uses the SAME scratch replica set and two tenants, but no remote
 // Cloudflare calls: only the S3/public-media endpoints are simulated.
 const r2Media=require('../src/tenant/workspace/r2Media');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y/9SxoAAAAASUVORK5CYII=','base64');
 const oldFetch=global.fetch,images=new Map();
 const keys=['R2_MEDIA_ACCOUNT_ID','R2_MEDIA_ACCESS_KEY_ID','R2_MEDIA_SECRET_ACCESS_KEY','R2_MEDIA_BUCKET','R2_MEDIA_PUBLIC_URL'];
 const oldEnvironment=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{R2_MEDIA_ACCOUNT_ID:'a'.repeat(32),R2_MEDIA_ACCESS_KEY_ID:'TEST_ONLY',
  R2_MEDIA_SECRET_ACCESS_KEY:'test-secret-no-real-credentials',
  R2_MEDIA_BUCKET:'finhub-scratch-media',R2_MEDIA_PUBLIC_URL:'https://media.example.invalid'});
 global.fetch=async(url,init={})=>{
  const u=new URL(String(url)),prefix='/finhub-scratch-media/';
  if(u.hostname==='a'.repeat(32)+'.r2.cloudflarestorage.com'){
   assert(u.pathname.startsWith(prefix));assert.match(String(init.headers?.Authorization||''),/AWS4-HMAC-SHA256/);
   const key=u.pathname.slice(prefix.length);
   if(init.method==='PUT'){images.set(key,Buffer.from(init.body));return new Response(null,{status:200});}
   if(init.method==='DELETE'){images.delete(key);return new Response(null,{status:204});}
   throw Error('Unexpected R2 operation');
  }
  if(u.hostname==='media.example.invalid'){
   const bytes=images.get(u.pathname.slice(1));
   return bytes?new Response(bytes,{status:200,headers:{'content-type':'image/png'}}):new Response(null,{status:404});
  }
  return oldFetch(url,init);
 };
 try{
  const asset=await r2Media.upload(conn,tenant,owner,'logo',png,'image/png');
  assert.equal(asset.kind,'logo');
  const repeated=await r2Media.upload(conn,tenant,owner,'logo',png,'image/png');
  assert.equal(repeated.id,asset.id,'same image retry does not create a second object');
  assert.equal(repeated.reused,true);
  assert.equal(images.size,1);
  assert.equal((await r2Media.list(conn,tenant,owner)).length,1);
  assert.equal((await global.fetch(asset.url)).status,200);
  await assert.rejects(r2Media.remove(other,otherTenant,otherOwner,asset.id),{status:404});
  const otherSettings=await service.read(other,otherTenant,otherOwner);
  await assert.rejects(service.save(other,otherTenant,otherOwner,'landing',
   {headline:'Foreign asset',logoUrl:asset.url,revision:otherSettings.revision}),{status:409},
   'R2 assets cannot be attached to a different tenant');
  const beforeMedia=await service.read(conn,tenant,owner);
  const website={headline:beforeMedia.landing.headline,subtitle:beforeMedia.landing.subtitle,
   services:beforeMedia.landing.services.join(',')};
  const draftWithImage=await service.save(conn,tenant,owner,'landing',
   {...website,logoUrl:asset.url,revision:beforeMedia.revision});
  assert(!((await service.publicLanding(conn,tenant)).details.logoUrl),'draft image must not publish automatically');
  await assert.rejects(r2Media.remove(conn,tenant,owner,asset.id),{status:409});
  const liveWithImage=await service.publish(conn,tenant,owner,{revision:draftWithImage.revision});
  assert.equal(liveWithImage.directorySyncPending,false);
  assert.equal((await service.publicLanding(conn,tenant)).details.logoUrl,asset.url);
  assert.equal((await Tenant.findById(tenant._id).lean()).directory.logoUrl,asset.url);
  const draftWithoutImage=await service.save(conn,tenant,owner,'landing',
   {...website,logoUrl:'',revision:liveWithImage.revision});
  await assert.rejects(r2Media.remove(conn,tenant,owner,asset.id),{status:409},
   'removing from draft is insufficient until live profile is updated');
  const liveWithoutImage=await service.publish(conn,tenant,owner,{revision:draftWithoutImage.revision});
  assert.equal(liveWithoutImage.directorySyncPending,false);
  assert.equal((await Tenant.findById(tenant._id).lean()).directory.logoUrl,'');
  assert.deepEqual(await r2Media.remove(conn,tenant,owner,asset.id),{removed:true});
  assert.equal((await r2Media.list(conn,tenant,owner)).length,0);
  assert.equal((await global.fetch(asset.url)).status,404);
  assert.equal(await models.auditEventModel(conn).countDocuments({action:'workspace.public_media.deleted'}),1);
  // Actual authenticated HTTP body parsing, session, owner permission and CSRF.
  const websitePage=await request('/tenant/workspace/landing');
  const mediaToken=csrf(websitePage.html);
  const postImage=(token,mime)=>global.fetch(base+'/tenant/workspace/media/cover',{
   method:'POST',redirect:'manual',
   headers:{cookie,'content-type':mime,'x-csrf-token':token,accept:'application/json'},body:png});
  assert.equal((await postImage('forged','image/png')).status,403,
   'forged CSRF token cannot upload image bytes');
  assert.equal((await postImage(mediaToken,'application/octet-stream')).status,415,
   'HTTP endpoint rejects unsupported image MIME types');
  const uploadResponse=await postImage(mediaToken,'image/png');
  assert.equal(uploadResponse.status,201,'owner can upload through authenticated HTTP route');
  const cover=await uploadResponse.json();assert.equal(cover.kind,'cover');
  const repeatResponse=await postImage(mediaToken,'image/png');
  assert.equal(repeatResponse.status,201);
  assert.equal((await repeatResponse.json()).id,cover.id,'HTTP retry must reuse existing image');
  await r2Media.remove(conn,tenant,owner,cover.id);
  assert.equal(images.size,0,'no test R2 objects remain');
  console.log('PASS: authenticated HTTP R2 upload, CSRF, MIME, deduplication, delete');
  console.log('PASS: tenant-isolated R2 image upload, draft, publication, removal and audited cleanup');
 }finally{
  global.fetch=oldFetch;
  for(const [key,value] of Object.entries(oldEnvironment)){
   if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
 }

 await models.tenantUserModel(conn).updateOne({_id:owner.id},{$set:{role:'Viewer',permissions:['*']}});await assert.rejects(service.save(conn,tenant,owner,'profile',{...profile('Escalation'),revision:prior.revision+1}),{status:403},'fresh stored role prevents stale owner escalation');await models.tenantUserModel(conn).updateOne({_id:owner.id},{$set:{role:'Tenant Owner',status:'disabled'}});await assert.rejects(service.read(conn,tenant,owner),{status:403});await models.tenantUserModel(conn).updateOne({_id:owner.id},{$set:{status:'active'}});
 await Tenant.updateOne({_id:tenant._id},{$set:{status:'suspended'}});await assert.rejects(service.read(conn,tenant,owner),{status:403},'fresh tenant status defeats stale caller data');await Tenant.updateOne({_id:tenant._id},{$set:{status:'active','subscription.status':'revoked'}});await assert.rejects(service.read(conn,tenant,owner),{status:403});
 console.log('PASS: Workspace settings, validated owner authorization, tenant binding, optimistic concurrency, transactional audit rollback, archive/restore, published snapshot isolation, real statistics and exports, escaped public HTTP content, CSRF, authenticated form persistence, and revocation.');
}
async function cleanup(){if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}if(mongoose.connection.readyState===1&&mongoose.connection.name===database&&/^cfh_workspace_probe_[a-f0-9]{16}$/.test(database)){for(const conn of connections)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('WORKSPACE SETTINGS INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Workspace scratch cleanup failed:',error.message);process.exitCode=1;}));
