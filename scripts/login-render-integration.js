'use strict';
require('dotenv').config();
process.env.MFA_ENABLED='true';
const req=require('node:module').createRequire(require('node:path').resolve(__dirname,'../package.json'));
const configured=new URL(req('./src/config/mongoUris').resolveMongoConfiguration(process.env).mongoPlatformUri);
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Login integration requires an isolated unauthenticated loopback replica set');
const crypto=require('node:crypto'),assert=require('node:assert/strict');
const nonce=crypto.randomBytes(8).toString('hex'),scratch='cfh_login_render_'+nonce,slug='login-render-'+nonce;
configured.pathname='/'+scratch;process.env.NODE_ENV='test';process.env.MONGO_PLATFORM_URI=configured.toString();delete process.env.PLATFORM_DB_URI;delete process.env.MONGO_URI_BASE;
process.env.APP_URL='http://localhost:3000';const originalKey=crypto.randomBytes(32).toString('hex'),changedKey=crypto.randomBytes(32).toString('hex');process.env.MFA_ENCRYPTION_KEY=originalKey;process.env.TRANSFER_SMS_PROVIDER='none';process.env.TENANT_BACKUPS_ENABLED='false';
const mongoose=req('mongoose'),bcrypt=req('bcryptjs'),mfa=req('./src/platform/services/mfa.service'),core=req('./src/tenant/models'),Tenant=req('./src/platform/models/Tenant'),Identity=req('./src/platform/models/AccountIdentity'),Admin=req('./src/platform/models/PlatformAdmin'),commerce=req('./src/platform/services/commercial.service');
const rows=[],secrets=new Map();let conn,server;
const csrf=html=>{const match=html.match(/name="_csrf" value="([a-f0-9]{64})"/);assert(match,'CSRF available');return match[1];};

async function verifyPlatformDirectories({base,headers,tenant,platformAccount,Audit}){
 const get=async(path,status=200)=>{
  const response=await fetch(base+path,{headers,redirect:'manual'});
  assert.equal(response.status,status,path);
  return response.text();
 };
 const olderEntries=html=>{
  const link=html.match(/href="([^"]+)">Older entries<\/a>/);
  assert(link,'Older entries link is available');
  return new URL(link[1].replaceAll('&amp;','&'),base);
 };
 const prefix='Directory fixture (QA)+';
 const subscription=tenant.toObject().subscription;
 const subscriptionFixtures=[{...subscription,periodStart:null},{...subscription,periodEnd:'legacy-invalid-date'},subscription];
 await Tenant.collection.insertMany(Array.from({length:102},(_,index)=>({
  name:`${prefix} #${index}`,slug:`directory-fixture-${index}`,owner:'Directory Owner',
  email:`fixture-${index}@example.invalid`,plan:tenant.plan,status:'active',setupStatus:'complete',
  enabledModules:tenant.enabledModules,
  ...(index<subscriptionFixtures.length?{subscription:subscriptionFixtures[index]}:{})
 })));

 const query=new URLSearchParams({q:prefix});
 const first=await get('/platform/tenants?'+query);
 assert.match(first,/directory-fixture-101/);
 assert.doesNotMatch(first,/directory-fixture-0(?:[\s"<]|$)/);
 const older=olderEntries(first);
 assert.equal(older.searchParams.get('q'),prefix);
 const second=await get(older.pathname+older.search);
 assert.match(second,/directory-fixture-0(?:[\s"<]|$)/);
 assert.doesNotMatch(second,/directory-fixture-101/);
 await get('/platform/tenants?before=invalid',400);

 const subscriptions=await get('/platform/subscriptions?q=directory-fixture-0');
 assert.match(subscriptions,/class="tag">restricted</);
 const invalidDate=await get('/platform/subscriptions?q=fixture-1%40example.invalid');
 assert.match(invalidDate,/Unknown date/);
 assert.match(invalidDate,/class="tag">restricted</);
 const active=await get('/platform/subscriptions?q=fixture-2%40example.invalid');
 assert.match(active,/class="tag">granted</);

 await Audit.collection.insertMany(Array.from({length:101},(_,index)=>({
  actorId:String(platformAccount.id),action:`integration.directory_${index}`,createdAt:new Date()
 })));
 const firstAudit=await get('/platform/audit');
 assert.match(firstAudit,/integration\.directory_100</);
 assert.doesNotMatch(firstAudit,/integration\.directory_0</);
 const olderAudit=olderEntries(firstAudit);
 const secondAudit=await get(olderAudit.pathname+olderAudit.search);
 assert.match(secondAudit,/integration\.directory_0</);
 assert.match(secondAudit,/Unknown date/);
 await get('/platform/audit?before=invalid',400);

 const settings=await get('/platform/settings');
 const response=await fetch(base+'/platform/settings/timezone',{
  method:'POST',redirect:'manual',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({_csrf:csrf(settings),timeZone:'Europe/Berlin'})
 });
 assert.equal(response.status,303,await response.text());
 assert.equal(response.headers.get('location'),'/platform/settings');
 assert.match(await get('/platform/settings'),/name="timeZone"[^>]+value="Europe\/Berlin"/);
 const audit=await Audit.findOne({action:'platform.timezone.changed',actorId:String(platformAccount.id)}).lean();
 assert.equal(audit?.after.timeZone,'Europe/Berlin');

 const Appointment=req('./src/platform/models/Appointment');
 const {insertedId}=await Appointment.collection.insertOne({
  businessName:'Legacy appointment fixture',contactName:'Directory Contact',status:'confirmed',revision:0,
  preferredDate:'legacy-invalid-date',scheduledAt:'legacy-invalid-date',
  decisions:[{action:'confirm',from:'pending',to:'confirmed',note:'Legacy note',at:'legacy-invalid-date'}]
 });
 assert.match(await get('/platform/appointments'),/Unknown date/);
 const appointmentPath='/platform/appointments/'+insertedId;
 const appointment=await get(appointmentPath);
 assert.match(appointment,/value="complete" disabled/);
 assert.match(appointment,/Legacy note/);
 const complete=token=>fetch(base+appointmentPath+'/decision',{
  method:'POST',redirect:'manual',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({_csrf:token,action:'complete',revision:'0',note:'Verify the scheduled appointment completion'})
 });
 assert.equal((await complete(csrf(appointment))).status,409);
 assert.equal((await Appointment.collection.findOne({_id:insertedId})).status,'confirmed');
 await Appointment.collection.updateOne({_id:insertedId},{$set:{scheduledAt:new Date(Date.now()-60000)}});
 const started=await get(appointmentPath);
 assert.doesNotMatch(started,/value="complete" disabled/);
 assert.equal((await complete(csrf(started))).status,303);
 assert.equal((await Appointment.collection.findOne({_id:insertedId})).status,'completed');
}

async function main(){
 await req('./src/config/mongo').connectPlatformMongo();await Promise.all([Tenant.createIndexes(),Identity.createIndexes(),Admin.createIndexes()]);
 const modules=['mobile_money','money_transfer','banking','forex','customers','accounts','expenses','reports'];const version={...commerce.asPlanVersion({...req('./src/data/store').plans.find(p=>p.code==='enterprise'),code:'mfa_review',modules}),status:'published'},terms=commerce.planSnapshot(version);
 const tenant=await Tenant.create({name:'MFA Key Review Workspace',slug,dbName:req('./src/config/tenantDatabaseName').tenantDbNameFromSlug(slug),owner:'Owner',email:'tenant-fresh-'+nonce+'@example.invalid',plan:'mfa_review',status:'active',setupStatus:'complete',enabledModules:modules,seatsReserved:3,branchCount:0,subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-10000),periodEnd:new Date(Date.now()+86400000)}});
 conn=req('./src/config/mongo').getTenantConnection(slug);await core.ensureTenantIndexes(conn);const password='MFA-Key-Review-'+nonce+'#9a',passwordHash=await bcrypt.hash(password,10);
 for(const kind of ['platform','tenant'])for(const enrolled of [false,true]){const email=kind+'-'+(enrolled?'enrolled':'fresh')+'-'+nonce+'@example.invalid',secret=enrolled?mfa.generateSecret():null,Model=kind==='platform'?Admin:core.tenantUserModel(conn),account=await Model.create({name:'MFA Key Review',email,passwordHash,role:kind==='platform'?'Super Admin':'Tenant Owner',status:'active',...(kind==='tenant'?{allowedModules:modules}:{}),...(enrolled?{mfaSecretEncrypted:mfa.encryptSecret(secret),mfaEnabledAt:new Date(),mfaLastCounter:-1}:{})});await Identity.create({email,kind,accountId:account._id,...(kind==='tenant'?{tenantId:tenant._id}:{})});rows.push({kind,enrolled,email,id:account._id,Model});if(secret)secrets.set(email,secret);}
 const Audit=req('./src/platform/models/PlatformAuditLog');const platformAccount=rows.find(row=>row.kind==='platform'&&row.enrolled);
 await Audit.collection.insertMany([null,undefined,'legacy-invalid-date'].map((createdAt,index)=>({actorId:platformAccount.id,action:'integration.legacy_audit_'+index,recordId:String(tenant._id),metadata:{},...(createdAt===undefined?{}:{createdAt})})));
 server=await new Promise(resolve=>{const s=req('./src/app')().listen(0,()=>resolve(s));});const base='http://127.0.0.1:'+server.address().port;
 const results=[];
 for(const condition of ['absent key','mismatched key','original key']){
  if(condition==='absent key')delete process.env.MFA_ENCRYPTION_KEY;else process.env.MFA_ENCRYPTION_KEY=condition==='original key'?originalKey:changedKey;
  for(const row of rows.filter(row=>condition==='absent key'||row.enrolled)){
   const signin=await fetch(base+'/signin'),cookie0=signin.headers.get('set-cookie').split(';')[0],token=csrf(await signin.text());
   const login=await fetch(base+'/signin',{method:'POST',redirect:'manual',headers:{cookie:cookie0,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:token,email:row.email,password}).toString()});const cookie=login.headers.get('set-cookie')?.split(';')[0]||cookie0,location=login.headers.get('location');
   const target=await fetch(base+location,{headers:{cookie},redirect:'manual'}),html=await target.text();const result={condition,kind:row.kind,enrolled:row.enrolled,loginStatus:login.status,loginRedirect:location,mfaPageStatus:target.status};
   assert.equal(login.status,303);assert.equal(location,row.enrolled?'/mfa/challenge':'/mfa/setup');
   if(row.enrolled){const answer=await fetch(base+'/mfa/challenge',{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf(html),code:mfa.counterCode(secrets.get(row.email),Math.floor(Date.now()/30000))}).toString()});result.mfaPostStatus=answer.status;result.mfaPostRedirect=answer.headers.get('location');if(condition==='original key'){assert.equal(answer.status,303);assert.equal(answer.headers.get('location'),row.kind==='platform'?'/platform/dashboard':'/tenant/dashboard');const fullCookie=answer.headers.get('set-cookie')?.split(';')[0]||cookie,headers={cookie:fullCookie};const dashboard=await fetch(base+answer.headers.get('location'),{headers,redirect:'manual'});assert.equal(dashboard.status,200,'real post-MFA dashboard');const dashboardHtml=await dashboard.text();
 if(row.kind==='platform'){assert.match(dashboardHtml,/Unknown date/);await verifyPlatformDirectories({base,headers,tenant,platformAccount,Audit});}
 else{const original=tenant.toObject().subscription;await Tenant.collection.updateOne({_id:tenant._id},{$set:{'subscription.periodEnd':'legacy-invalid-date'}});try{const redirect=await fetch(base+'/tenant/dashboard',{headers,redirect:'manual'});assert.equal(redirect.status,303);assert.equal(redirect.headers.get('location'),'/tenant/billing');const billing=await fetch(base+'/tenant/billing',{headers});assert.equal(billing.status,200);const billingHtml=await billing.text();assert.match(billingHtml,/Unknown date/);const denied=await fetch(base+'/tenant/money-transfer/requests',{method:'POST',redirect:'manual',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf(billingHtml)}).toString()});assert.equal(denied.status,403);}finally{await Tenant.collection.updateOne({_id:tenant._id},{$set:{subscription:original}});}}
}else assert.equal(answer.status,503);}
   else assert.equal(target.status,503);
   results.push(result);
  }
 }
 console.log('PASS: real password/MFA redirects and dashboards, directory and audit pagination, legacy subscription and audit data, audited timezone and appointment changes, and financial access denial for invalid subscriptions. Disposable local storage only.');
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{if(server)await new Promise(resolve=>server.close(resolve));if(conn&&mongoose.connection.name===scratch&&/^cfh_login_render_[a-f0-9]{16}$/.test(scratch)){await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();});
