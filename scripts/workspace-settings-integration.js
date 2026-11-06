#!/usr/bin/env node
'use strict';
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
let connections=[],server;
const profile=(name='Workspace business')=>({name,legalName:'Workspace Business Limited',owner:'Owner',ownerEmail:'owner@example.invalid',supportPhone:'+256700123456',country:'Uganda',timezone:'Africa/Kampala',defaultCurrency:'UGX'});
const brand={theme:'Approved theme',primary:'#123456',secondary:'#345678',logoStatus:'Not uploaded',receiptNote:'Saved receipt footer',prefix:'WS',template:'Tenant receipt'};
const csrf=html=>{const found=html.match(/name="_csrf" value="([a-f0-9]{64})"/);assert(found,'CSRF token is rendered');return found[1];};
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 for(const model of [Tenant,Identity,require('../src/platform/models/LoginThrottle'),require('../src/platform/models/SecurityEvent')])await model.createIndexes();
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
 saved=await service.save(conn,tenant,owner,'landing',{headline:'Published <script>example()</script>',subtitle:'Published customer description',services:'Mobile Money,Forex',revision:3});assert.equal(saved.revision,4);
 const published=await service.writeEntry(conn,tenant,owner,'landing_section',{name:'Published services',description:'Published body <img src=x onerror=unsafe()>',status:'published',order:'1'});
 const draft=await service.writeEntry(conn,tenant,owner,'landing_section',{name:'Private draft section',description:'Never public until published',status:'draft',order:'2'});
 await service.publish(conn,tenant,owner,{revision:4});let landing=await service.publicLanding(conn,tenant);assert.equal(landing.sections.length,1);assert.equal(landing.sections[0].name,'Published services');
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
 const otherPage=await request('/t/'+otherTenant.slug);assert.equal(otherPage.response.status,200);assert.doesNotMatch(otherPage.html,/Published services|Published customer description/);
 const anon=await request('/tenant/workspace/profile');assert.equal(anon.response.status,303);assert.equal(anon.response.headers.get('location'),'/signin');
 const signIn=await request('/signin');await request('/signin',{email:tenant.email,password,_csrf:csrf(signIn.html)});const challenge=await request('/mfa/challenge');const verification=await request('/mfa/challenge',{code:mfa.counterCode(secret,Math.floor(Date.now()/30000)),_csrf:csrf(challenge.html)});assert.equal(verification.response.status,303,verification.html);
 for(const path of ['','/profile','/landing','/branding','/roles','/kyc','/database','/subscription','/notification-rules','/integrations','/import-export','/compliance','/landing-preview','/receipt-preview','/customer-portal-preview','/audit','/control','/profile/edit','/branding/edit','/branding/receipt/edit','/landing/headline/edit','/entries/landing_section/new']){const page=await request('/tenant/workspace'+path);assert.equal(page.response.status,200,`${path}: ${page.html.slice(0,600)}`);assert.doesNotMatch(page.html,/passwordHash|mfaSecretEncrypted/);}
 const profilePage=await request('/tenant/workspace/profile');const prior=await service.read(conn,tenant,owner);const forgedCsrf=await request('/tenant/workspace/profile',{...profile(),revision:prior.revision,_csrf:'forged'});assert.equal(forgedCsrf.response.status,403);assert.equal((await service.read(conn,tenant,owner)).revision,prior.revision);
 const updated=await request('/tenant/workspace/profile',{...profile('Saved through authenticated form'),revision:prior.revision,_csrf:csrf(profilePage.html)});assert.equal(updated.response.status,303,updated.html);assert.equal((await service.read(conn,tenant,owner)).profile.name,'Saved through authenticated form');
 const css=await request('/tenant/workspace/theme.css');assert.equal(css.response.status,200);assert.match(css.response.headers.get('content-type'),/text\/css/);assert.match(css.html,/--primary:#123456/);assert.doesNotMatch(css.html,/<script|owner@example/);
 await models.tenantUserModel(conn).updateOne({_id:owner.id},{$set:{role:'Viewer',permissions:['*']}});await assert.rejects(service.save(conn,tenant,owner,'profile',{...profile('Escalation'),revision:prior.revision+1}),{status:403},'fresh stored role prevents stale owner escalation');await models.tenantUserModel(conn).updateOne({_id:owner.id},{$set:{role:'Tenant Owner',status:'disabled'}});await assert.rejects(service.read(conn,tenant,owner),{status:403});await models.tenantUserModel(conn).updateOne({_id:owner.id},{$set:{status:'active'}});
 await Tenant.updateOne({_id:tenant._id},{$set:{status:'suspended'}});await assert.rejects(service.read(conn,tenant,owner),{status:403},'fresh tenant status defeats stale caller data');await Tenant.updateOne({_id:tenant._id},{$set:{status:'active','subscription.status':'revoked'}});await assert.rejects(service.read(conn,tenant,owner),{status:403});
 console.log('PASS: Workspace settings, validated owner authorization, tenant binding, optimistic concurrency, transactional audit rollback, archive/restore, published snapshot isolation, real statistics and exports, escaped public HTTP content, CSRF, authenticated form persistence, and revocation.');
}
async function cleanup(){if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}if(mongoose.connection.readyState===1&&mongoose.connection.name===database&&/^cfh_workspace_probe_[a-f0-9]{16}$/.test(database)){for(const conn of connections)await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();}
main().catch(error=>{console.error('WORKSPACE SETTINGS INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Workspace scratch cleanup failed:',error.message);process.exitCode=1;}));
