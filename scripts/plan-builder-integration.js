#!/usr/bin/env node
'use strict';
// Disposable authenticated HTTP + replica-set plan administration probe.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const uri=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||uri.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(uri.hostname)||uri.host.includes(',')||uri.username||uri.password)throw Error('Plan builder integration requires one unauthenticated loopback replica set');
const database='cfh_plan_builder_probe_'+crypto.randomBytes(8).toString('hex');uri.pathname='/'+database;process.env.MONGO_PLATFORM_URI=uri.toString();process.env.NODE_ENV='test';process.env.MFA_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');
const mongoose=require('mongoose'),bcrypt=require('bcryptjs');
const {connectPlatformMongo}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const PlanVersion=require('../src/platform/models/PlanVersion'),PlanDraft=require('../src/platform/models/PlanDraft'),Audit=require('../src/platform/models/PlatformAuditLog'),Admin=require('../src/platform/models/PlatformAdmin'),Identity=require('../src/platform/models/AccountIdentity');
const mfa=require('../src/platform/services/mfa.service'),createApp=require('../src/app'),commerce=require('../src/platform/services/commercial.service');
let server,cookie='';
const reason='Reviewed module access, pricing and capacity for this new plan version.';
function csrf(html){const token=html.match(/name="_csrf" value="([a-f0-9]{64})"/);assert(token,'CSRF token rendered');return token[1];}
function form(changes={}){return {code:'custom_manual',name:'Manual workspace',description:'A configurable manual recording workspace.',priceMonthly:'80.00',priceYearly:'800.00',trialMonths:'1',entryMode:'manual',modules:['mobile_money'],limit_users:'5',limit_branches:'2',limit_transactionsPerMonth:'1000',limit_smsPerMonth:'0',limit_storageMb:'1000',availableForNewTenants:'true',revision:'0',baseVersion:'0',...changes};}
async function main(){
 await connectPlatformMongo();verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 for(const Model of [PlanVersion,PlanDraft,Audit,Admin,Identity,require('../src/platform/models/PlanPublicationLock'),require('../src/platform/models/LoginThrottle'),require('../src/platform/models/SecurityEvent')])await Model.createIndexes();
 const password='Plan-Builder-Integration#2026',secret=mfa.generateSecret();
 const admin=await Admin.create({name:'Plan Administrator',email:'plan-admin@example.invalid',passwordHash:await bcrypt.hash(password,12),role:'Super Admin',status:'active',mfaSecretEncrypted:mfa.encryptSecret(secret),mfaEnabledAt:new Date(),mfaLastCounter:-1});await Identity.create({email:admin.email,kind:'platform',accountId:admin._id});
 server=await new Promise(resolve=>{const instance=createApp().listen(0,()=>resolve(instance));});const base='http://127.0.0.1:'+server.address().port;
 async function request(route,values){const params=new URLSearchParams();for(const [key,value] of Object.entries(values||{}))for(const item of Array.isArray(value)?value:[value])params.append(key,item);const response=await fetch(base+route,{method:values?'POST':'GET',redirect:'manual',headers:{...(cookie?{cookie}:{}),...(values?{'content-type':'application/x-www-form-urlencoded'}:{})},...(values?{body:params.toString()}:{})});cookie=response.headers.get('set-cookie')?.split(';')[0]||cookie;return {response,html:await response.text()};}
 const anon=await request('/signin');const denied=await request('/platform/plans/drafts',{...form(),_csrf:csrf(anon.html)});assert.equal(denied.response.headers.get('location'),'/signin');assert.equal(await PlanDraft.countDocuments(),0);
 const login=await request('/signin');await request('/signin',{email:admin.email,password,_csrf:csrf(login.html)});const challenge=await request('/mfa/challenge');await request('/mfa/challenge',{code:mfa.counterCode(secret,Math.floor(Date.now()/30000)),_csrf:csrf(challenge.html)});
 const editor=await request('/platform/plans/new');assert.equal(editor.response.status,200);assert.match(editor.html,/SMS Capture/);
 const invalid=await request('/platform/plans/drafts',{...form({priceMonthly:'-1'}),_csrf:csrf(editor.html)});assert.equal(invalid.response.status,400);assert.match(invalid.html,/value="Manual workspace"/);
 const saved=await request('/platform/plans/drafts',{...form(),_csrf:csrf(editor.html)});assert.equal(saved.response.status,303,saved.html);assert.equal(saved.response.headers.get('location'),'/platform/plans/custom_manual/edit');assert.equal(await PlanVersion.countDocuments(),0,'saving a draft does not publish access');
 let draft=await PlanDraft.findOne({code:'custom_manual'}).lean();assert.equal(draft.revision,1);
 const forged=await request('/platform/plans/custom_manual/publish',{revision:'1',reason,_csrf:'forged'});assert.equal(forged.response.status,403);assert.equal(await PlanVersion.countDocuments(),0);
 const manualEditor=await request('/platform/plans/custom_manual/edit');const published=await request('/platform/plans/custom_manual/publish',{revision:'1',reason,_csrf:csrf(manualEditor.html)});assert.equal(published.response.status,303,published.html);
 const manual=await PlanVersion.findOne({code:'custom_manual',version:1}).lean();assert(manual);assert.equal(manual.priceMonthlyMinor,8000);assert.deepEqual(manual.modules,['mobile_money']);const originalSnapshot=commerce.planSnapshot(manual);
 const createForm=await request('/platform/tenants/create');assert.match(createForm.html,/value="custom_manual"/,'custom plan is selectable for tenant creation');
 const customSlug='plan-trial-'+database.slice(-16);
 const customTenant=await request('/platform/tenants',{name:'Custom Plan Tenant',slug:customSlug,owner:'Custom Owner',email:'owner-'+database.slice(-16)+'@example.invalid',plan:'custom_manual',_csrf:csrf(createForm.html)});
 assert.equal(customTenant.response.status,200,customTenant.html);
 const createdTenant=await require('../src/platform/models/Tenant').findOne({slug:customSlug}).lean();assert(createdTenant);assert.equal(createdTenant.subscription.planCode,'custom_manual');assert.deepEqual(createdTenant.enabledModules,['mobile_money']);
 const livePricing=await request('/pricing');assert.equal(livePricing.response.status,200);assert.match(livePricing.html,/data-plan-code="custom_manual"/);assert.match(livePricing.html,/USD \$80\.00\/mo/);assert.doesNotMatch(livePricing.html,/data-plan-code="agent"/,'connected pricing never falls back to seeded plans');
 const again=await request('/platform/plans/custom_manual/publish',{revision:'1',reason,_csrf:csrf(manualEditor.html)});assert.equal(again.response.status,409);assert.equal(await PlanVersion.countDocuments({code:'custom_manual'}),1);
 const automatic=form({code:'custom_auto',name:'Automatic workspace',entryMode:'sms_assisted',manualPlanCode:'custom_manual',modules:['mobile_money','sms_capture'],limit_smsPerMonth:'1000'});
 const autoSave=await request('/platform/plans/drafts',{...automatic,_csrf:csrf(manualEditor.html)});assert.equal(autoSave.response.status,303,autoSave.html);
 const autoEditor=await request('/platform/plans/custom_auto/edit');const tooCheap=await request('/platform/plans/custom_auto/publish',{revision:'1',reason,_csrf:csrf(autoEditor.html)});assert.equal(tooCheap.response.status,409);assert.match(tooCheap.html,/prices must both be higher/);assert.equal(await PlanVersion.countDocuments({code:'custom_auto'}),0);
 const revised=await request('/platform/plans/custom_auto/draft',{...automatic,priceMonthly:'100.00',priceYearly:'1000.00',revision:'1',baseVersion:'0',_csrf:csrf(autoEditor.html)});assert.equal(revised.response.status,303,revised.html);
 const autoReady=await request('/platform/plans/custom_auto/edit');const autoPublished=await request('/platform/plans/custom_auto/publish',{revision:'2',reason,_csrf:csrf(autoReady.html)});assert.equal(autoPublished.response.status,303,autoPublished.html);
 const automaticVersion=await PlanVersion.findOne({code:'custom_auto',version:1}).lean();assert.equal(automaticVersion.manualPlanVersion,1);assert.equal(automaticVersion.priceMonthlyMinor,10000);assert(automaticVersion.modules.includes('mobile_money'),'manual operations retained');assert(automaticVersion.modules.includes('sms_capture'));
 const liveComparison=await request('/price-compare');assert.equal(liveComparison.response.status,200);assert.match(liveComparison.html,/data-plan-code="custom_auto"/);assert.match(liveComparison.html,/USD \$100\.00 \/ month/);assert.match(liveComparison.html,/SMS-assisted \+ manual/);
 const currentManual=await request('/platform/plans/custom_manual/edit');const update=await request('/platform/plans/custom_manual/draft',{...form(),revision:'1',baseVersion:'1',priceMonthly:'90.00',priceYearly:'900.00',availableForNewTenants:'false',_csrf:csrf(currentManual.html)});assert.equal(update.response.status,303,update.html);
 const manualDraft=await request('/platform/plans/custom_manual/edit');const next=await request('/platform/plans/custom_manual/publish',{revision:'2',reason,_csrf:csrf(manualDraft.html)});assert.equal(next.response.status,303,next.html);
 assert.equal((await PlanVersion.findOne({code:'custom_manual',version:1})).priceMonthlyMinor,8000,'publishing new terms never rewrites v1');assert.deepEqual(commerce.planSnapshot(await PlanVersion.findOne({code:'custom_manual',version:1}).lean()),originalSnapshot,'assigned snapshot terms remain reproducible');assert.equal((await PlanVersion.findOne({code:'custom_manual',version:2})).availableForNewTenants,false);
 const publicAfterHide=await request('/pricing');assert.equal(publicAfterHide.response.status,200);assert.doesNotMatch(publicAfterHide.html,/data-plan-code="custom_manual"/,'latest hidden version cannot resurrect the older manual price');assert.match(publicAfterHide.html,/data-plan-code="custom_auto"/);
 assert.equal(await Audit.countDocuments({action:'catalog.plan_version_published',actorId:String(admin._id)}),3,'all three published versions belong to the authenticated administrator');
 const stale=await request('/platform/plans/custom_manual/draft',{...form(),revision:'1',baseVersion:'1',_csrf:csrf(manualDraft.html)});assert.equal(stale.response.status,409,'stale editor cannot overwrite a newer version');
 const paidForm=await request('/platform/plans/new');
 const paidSaved=await request('/platform/plans/drafts',{...form({code:'custom_paid',name:'Paid without trial',trialMonths:'0'}),_csrf:csrf(paidForm.html)});assert.equal(paidSaved.response.status,303,paidSaved.html);
 const paidEditor=await request('/platform/plans/custom_paid/edit');
 const paidPublished=await request('/platform/plans/custom_paid/publish',{revision:'1',reason,_csrf:csrf(paidEditor.html)});assert.equal(paidPublished.response.status,303,paidPublished.html);
 const paidCreate=await request('/platform/tenants/create');assert.match(paidCreate.html,/value="custom_paid"/);
 const paidSlug='plan-paid-'+database.slice(-16);
 const paidTenant=await request('/platform/tenants',{name:'Paid Plan Tenant',slug:paidSlug,owner:'Paid Owner',email:'paid-'+database.slice(-16)+'@example.invalid',plan:'custom_paid',_csrf:csrf(paidCreate.html)});assert.equal(paidTenant.response.status,200,paidTenant.html);assert.match(paidTenant.html,/plan has no trial/);
 const waiting=await require('../src/platform/models/Tenant').findOne({slug:paidSlug}).lean();assert.equal(waiting.status,'past_due');assert.equal(waiting.subscription,undefined);assert.deepEqual(waiting.enabledModules,[],'no paid access is silently granted');
 const paidAccess=await request('/platform/tenants/'+waiting._id+'/subscription/grant',{planCode:'custom_paid',days:'30',reason,_csrf:csrf(paidCreate.html)});assert.equal(paidAccess.response.status,303,paidAccess.html);
 const activated=await require('../src/platform/models/Tenant').findById(waiting._id).lean();assert.equal(activated.status,'active');assert.equal(activated.subscription.source,'manual_admin_grant');assert.deepEqual(activated.enabledModules,['mobile_money']);
 const priceEditor=await request('/platform/plans/custom_manual/edit');
 const priceDraft=await request('/platform/plans/custom_manual/draft',{...form({revision:'2',baseVersion:'2',priceMonthly:'140.00',priceYearly:'1400.00'}),_csrf:csrf(priceEditor.html)});assert.equal(priceDraft.response.status,303,priceDraft.html);
 const priceReady=await request('/platform/plans/custom_manual/edit');
 const priceBlocked=await request('/platform/plans/custom_manual/publish',{revision:'3',reason,_csrf:csrf(priceReady.html)});assert.equal(priceBlocked.response.status,409);assert.match(priceBlocked.html,/Publish higher monthly and yearly SMS-assisted prices/);assert.equal(await PlanVersion.countDocuments({code:'custom_manual'}),2,'manual increase cannot undercut its available SMS premium');
 const manualTerms=require('../src/platform/services/planBuilder.service').parseForm(form({priceMonthly:'140.00',priceYearly:'1400.00'}));
 await assert.rejects(commerce.publishNextVersion(manualTerms,reason,{apply:true}),{status:409},'CLI publication enforces the same manual-to-SMS premium');
 for(const prices of [{priceMonthlyMinor:10000,priceYearlyMinor:90000},{priceMonthlyMinor:9000,priceYearlyMinor:100000}]){
  await assert.rejects(commerce.publishNextVersion({...manualTerms,...prices},reason),{status:409},'each billing interval must preserve a strictly positive premium');
 }
 const assignedAfterBlock=await require('../src/platform/models/Tenant').findById(createdTenant._id).lean();assert.equal(assignedAfterBlock.subscription.priceMonthlyMinor,8000);assert.equal(assignedAfterBlock.subscription.planVersion,1,'blocked publication never rewrites assigned subscriber terms');
 const autoTerms=require('../src/platform/services/planBuilder.service').termsFromVersion(automaticVersion);
 await commerce.publishNextVersion({...autoTerms,priceMonthlyMinor:16000,priceYearlyMinor:160000},reason,{apply:true});
 const priceAllowed=await request('/platform/plans/custom_manual/publish',{revision:'3',reason,_csrf:csrf(priceReady.html)});assert.equal(priceAllowed.response.status,303,priceAllowed.html);assert.equal((await commerce.latestPublished('custom_manual')).priceMonthlyMinor,14000,'manual increase succeeds after publishing a higher SMS price');
 await commerce.publishNextVersion({...autoTerms,priceMonthlyMinor:15000,priceYearlyMinor:150000,availableForNewTenants:false},reason,{apply:true});
 const retiredEditor=await request('/platform/plans/custom_manual/edit');
 const retiredDraft=await request('/platform/plans/custom_manual/draft',{...form({revision:'3',baseVersion:'3',priceMonthly:'180.00',priceYearly:'1800.00'}),_csrf:csrf(retiredEditor.html)});assert.equal(retiredDraft.response.status,303,retiredDraft.html);
 const retiredReady=await request('/platform/plans/custom_manual/edit');
 const retiredPublished=await request('/platform/plans/custom_manual/publish',{revision:'4',reason,_csrf:csrf(retiredReady.html)});assert.equal(retiredPublished.response.status,303,retiredPublished.html);assert.equal((await commerce.latestPublished('custom_manual')).priceMonthlyMinor,18000,'retired latest SMS version does not resurrect its earlier available price');
 assert.deepEqual(commerce.planSnapshot(await PlanVersion.findOne({code:'custom_manual',version:1}).lean()),originalSnapshot,'price changes and retirement preserve historical subscriber terms');
 const builder=require('../src/platform/services/planBuilder.service'),publicationLock=require('../src/platform/models/PlanPublicationLock');
 const actor={id:String(admin._id),name:admin.name,permissions:['*']};
 const raceManual=form({code:'race_manual',name:'Concurrent manual plan'}),raceAuto=form({code:'race_auto',name:'Concurrent SMS plan',priceMonthly:'100.00',priceYearly:'1000.00',entryMode:'sms_assisted',manualPlanCode:'race_manual',modules:['mobile_money','sms_capture'],limit_smsPerMonth:'1000'});
 for(const values of [raceManual,raceAuto]){await builder.saveDraft(actor,values);await builder.publishDraft(actor,values.code,{revision:'1',reason});}
 await builder.saveDraft(actor,{...raceManual,revision:'1',baseVersion:'1',priceMonthly:'95.00',priceYearly:'950.00'},raceManual.code);
 const originalLockUpdate=publicationLock.findOneAndUpdate;let fenceAttempts=0,releaseOverlap;
 const overlapping=new Promise(resolve=>{releaseOverlap=resolve;});
 publicationLock.findOneAndUpdate=async function(...args){
  const attempt=++fenceAttempts;if(attempt===2)releaseOverlap();
  const locked=await originalLockUpdate.apply(this,args);
  if(attempt===1){let timer;try{await Promise.race([overlapping,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Concurrent publication did not reach its shared fence')),3000);})]);}finally{clearTimeout(timer);}}
  return locked;
 };
 let competing;
 try{competing=await Promise.allSettled([
  builder.publishDraft(actor,'race_manual',{revision:'2',reason}),
  commerce.publishNextVersion(builder.parseForm({...raceAuto,priceMonthly:'90.00',priceYearly:'900.00'}),reason,{apply:true})
 ]);}finally{publicationLock.findOneAndUpdate=originalLockUpdate;}
 assert(fenceAttempts>=2,'builder and CLI publication share the same write fence');
 assert.equal(competing.filter(result=>result.status==='fulfilled').length,1,'simultaneous manual increase and SMS decrease cannot both commit');
 const rejected=competing.find(result=>result.status==='rejected');assert.equal(rejected.reason.status,409,rejected.reason.stack);
 const concurrentManual=await commerce.latestPublished('race_manual'),concurrentAuto=await commerce.latestPublished('race_auto');
 assert(concurrentAuto.priceMonthlyMinor>concurrentManual.priceMonthlyMinor&&concurrentAuto.priceYearlyMinor>concurrentManual.priceYearlyMinor,'available prices retain the SMS premium after concurrent cross-plan publication');
 assert.equal((await PlanVersion.findOne({code:'race_manual',version:1})).priceMonthlyMinor,8000,'concurrent publication preserves the earlier immutable version');
 console.log('PASS: authenticated draft creation, custom plan publication, field validation, CSRF, symmetric SMS premium pricing, shared publication fence, manual fallback, immutable version history, availability, concurrency and administrator audits');
}
async function cleanup(){if(server)await new Promise(resolve=>server.close(resolve));if(mongoose.connection.readyState===1&&mongoose.connection.name===database&&/^cfh_plan_builder_probe_[a-f0-9]{16}$/.test(database)){
 for(const tenant of await require('../src/platform/models/Tenant').find({}).lean()){
  if(tenant.slug.endsWith(database.slice(-16)))await require('../src/config/mongo').getTenantConnection(tenant.slug).db.dropDatabase();
 }
 await mongoose.connection.db.dropDatabase();
 }await mongoose.disconnect();}
main().catch(error=>{console.error('Plan builder integration FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Plan builder cleanup FAILED:',error.message);process.exitCode=1;}));
