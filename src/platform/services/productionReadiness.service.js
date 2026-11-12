'use strict';
// Read-only launch probes. Passing these is not a substitute for a restore,
// delivery, access review or external load test on the actual deployment.
const crypto=require('node:crypto');
const FORBIDDEN_ROLES=new Set(['root','atlasAdmin','dbOwner','userAdmin','userAdminAnyDatabase','clusterAdmin','clusterManager','hostManager','dbAdminAnyDatabase','readWriteAnyDatabase','readAnyDatabase']);
const MANUAL_EVIDENCE=Object.freeze([
 'Restore the latest offsite backup on an isolated host and record measured RPO/RTO.',
 'Verify least-privilege database/IAM roles, firewall rules, key escrow and independent alert reception.',
 'Confirm a real password-recovery email reaches an inbox and Android gateway messages match the configured provider profile.',
 'Complete the production browser/accessibility/load smoke and approve the manual financial operating procedures.'
]);
const check=(name,passed,reason)=>({name,passed,...(reason?{reason}: {})});
function parseMongo(value){try{if(typeof value!=='string'||!/^mongodb(?:\+srv)?:\/\/[^/]+\/[^?/#]+(?:\?|$)/.test(value))return null;const options=new (require('mongoose').mongo.MongoClient)(value).options;return {database:options.dbName,tls:options.tls===true&&!options.tlsInsecure&&options.rejectUnauthorized!==false&&typeof options.checkServerIdentity!=='function',username:options.credentials?.username||null};}catch{return null;}}
function mongoTls(uri){return Boolean(uri?.tls);}
function configured(value){return typeof value==='string'&&value.trim().length>0&&!/replace[-_ ]|changeme|example\.(?:com|invalid)|your[-_ ]/i.test(value);}
function publicOrigin(value){try{const url=new URL(value);if(require('node:net').isIP(url.hostname.replace(/^\[|\]$/g,''))||!url.hostname.includes('.')||/^(?:[^.]+\.)*example\.(?:com|org|net)$/i.test(url.hostname)||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||/^(?:localhost|127\.|\[?::1\]?$)/i.test(url.hostname)||/\.(?:example|invalid|localhost|test)$/i.test(url.hostname))return null;return url.origin;}catch{return null;}}
function configurationChecks(input){
 const entries=[],origin=publicOrigin(input.APP_URL);
 let mongoConfiguration=null;
 try{mongoConfiguration=require('../../config/mongoUris').resolveMongoConfiguration(input);}catch{}
 entries.push(check('production_mode',input.NODE_ENV==='production','NODE_ENV must be production.'));
 entries.push(check('public_https_origin',Boolean(origin),'APP_URL must be the actual HTTPS origin, not a placeholder or localhost.'));
 entries.push(check('session_secret',configured(input.SESSION_SECRET)&&input.SESSION_SECRET.length>=32,'A unique SESSION_SECRET of at least 32 characters is required.'));
 entries.push(check('mfa_key',/^[a-f0-9]{64}$/i.test(input.MFA_ENCRYPTION_KEY||'')&&!/^([a-f0-9])\1{63}$/i.test(input.MFA_ENCRYPTION_KEY||''),'A separate random 32-byte hexadecimal MFA_ENCRYPTION_KEY is required.'));
 entries.push(check('separate_web_secrets',Boolean(input.MFA_ENCRYPTION_KEY)&&input.MFA_ENCRYPTION_KEY!==input.SESSION_SECRET,'Session and encryption secrets must be different.'));
 entries.push(check('trusted_proxy_hops',/^[12]$/.test(input.TRUST_PROXY||''),'TRUST_PROXY must match the actual one or two trusted proxy hops.'));
 entries.push(check('port',/^\d+$/.test(input.PORT||'3000')&&Number(input.PORT||3000)>=1&&Number(input.PORT||3000)<=65535,'PORT must be an integer from 1 to 65535.'));
 entries.push(check('provider_execution_disabled',input.REAL_MONEY_ENABLED==='false','REAL_MONEY_ENABLED must remain explicitly false; manual books do not certify provider execution.'));
 entries.push(check('recovery_mail_configured',configured(input.RESEND_API_KEY)&&configured(input.MAIL_FROM)&&/^(?:[^<>\r\n]{1,80}\s<)?[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>?$/.test(input.MAIL_FROM),'Configure Resend and a verified MAIL_FROM address; delivery still needs a real inbox test.'));
 let smsValid=false;
 try{require('../../tenant/transferSms/config').validateConfig(input,{worker:true});smsValid=true;}catch{}
 entries.push(check('transfer_sms_configuration',smsValid,'Transfer SMS requires a supported provider, a dedicated encryption key and complete notification-worker credentials when enabled.'));
 if(input.TRANSFER_SMS_ENCRYPTION_KEY){
  const smsKey=String(input.TRANSFER_SMS_ENCRYPTION_KEY).toLowerCase();
  entries.push(check('separate_transfer_sms_key',/^[a-f0-9]{64}$/.test(smsKey)&&!/^([a-f0-9])\1{63}$/.test(smsKey)&&smsKey!==String(input.MFA_ENCRYPTION_KEY||'').toLowerCase()&&smsKey!==String(input.SESSION_SECRET||'').toLowerCase(),'Use a separate random 32-byte hexadecimal transfer SMS encryption key; do not reuse session or MFA keys.'));
 }
 entries.push(check('mongo_alias_and_base_configuration',Boolean(mongoConfiguration),'Use MONGO_PLATFORM_URI or PLATFORM_DB_URI consistently; an optional MONGO_URI_BASE must share deployment, credentials, explicit authSource and connection options.'));
 if(input.TENANT_BACKUPS_ENABLED==='true'){
  let backup=null;try{backup=require('../../tenant/backups/config').settings(input);}catch{}
  entries.push(check('tenant_backup_configuration',Boolean(backup?.enabled),'Tenant backups require a dedicated encryption key and absolute persistent directory.'));
  entries.push(check('tenant_backup_google_configuration',Boolean(backup?.google),'Configure the Google OAuth client and exact callback URL for the requested Drive feature.'));
 }
 const keys=['MONGO_PLATFORM_URI','MONGO_WORKER_URI','MONGO_NOTIFICATION_WORKER_URI',...(input.TENANT_BACKUPS_ENABLED==='true'?['MONGO_BACKUP_WORKER_URI']:[])],uris=keys.map(key=>parseMongo(key==='MONGO_PLATFORM_URI'?mongoConfiguration?.mongoPlatformUri:input[key]));
 keys.forEach((key,index)=>{
  const uri=uris[index];entries.push(check(key.toLowerCase()+'_configured',Boolean(uri),key+' must explicitly name its platform database.'));
  entries.push(check(key.toLowerCase()+'_tls',mongoTls(uri),key+' must use TLS, including TLS over a private production network.'));
 });
 entries.push(check('same_platform_database',uris.every(Boolean)&&new Set(uris.map(uri=>uri&&uri.database)).size===1,'All service URIs must identify the same platform database.'));
 if(uris.every(uri=>uri?.username)){
  entries.push(check('separate_service_principals',new Set(uris.map(uri=>uri.username)).size===keys.length,'Each service needs a distinct database principal.'));
 }
 return {origin,checks:entries.map(entry=>entry.passed?{name:entry.name,passed:true}:entry)};
}
async function inspectMongo(uri,{kind='web',connect,now=new Date()}={}){
 let connection;
 try{
  connection=await (connect?connect(uri):require('mongoose').createConnection(uri,{serverSelectionTimeoutMS:7000,maxPoolSize:2,autoIndex:false,retryWrites:true}).asPromise());
  const hello=await connection.db.admin().command({hello:1,maxTimeMS:2000});
  const primary=Boolean(hello.setName&&hello.isWritablePrimary);
  const auth=await connection.db.command({connectionStatus:1,showPrivileges:false});
  const info=auth.authInfo||{},authenticated=(info.authenticatedUsers||[]).length>0;
  const excessive=(info.authenticatedUserRoles||[]).some(role=>FORBIDDEN_ROLES.has(role.role));
  const checks=[check(kind+'_replica_primary',primary,'A writable MongoDB replica-set primary is required.'),check(kind+'_authenticated',authenticated,'Unauthenticated database access is not accepted for launch.'),check(kind+'_non_administrative_principal',!excessive,'An administrative database role is configured; review service privileges.')];
  if(kind!=='web'){
   const prefix=kind==='outbox'?/^outbox-/:kind==='backup'?/^tenant-backup-/:/^notification-/;
   const active=await connection.db.collection('workerheartbeats').countDocuments({workerId:prefix,seenAt:{$gte:new Date(now.valueOf()-45000)}},{maxTimeMS:2000});
   checks.push(check(kind+'_worker_heartbeat',active>0,'No recent heartbeat from the correct worker class.'));
  }
  if(kind==='outbox'){
   const events=connection.db.collection('outboxevents');
   const [dead,late]=await Promise.all([events.countDocuments({state:'dead'},{maxTimeMS:2000}),events.countDocuments({state:'pending',availableAt:{$lt:new Date(now.valueOf()-300000)}},{maxTimeMS:2000})]);
   checks.push(check('outbox_queue',dead===0&&late===0,'Dead letters or overdue outbox deliveries need investigation.'));
  }
  return {checks:checks.map(entry=>entry.passed?{name:entry.name,passed:true}:entry),principalFingerprint:authenticated?crypto.createHash('sha256').update(JSON.stringify(info.authenticatedUsers.map(user=>[user.db,user.user]).sort())).digest('hex'):null,topologyFingerprint:hello.setName&&hello.hosts?.length?crypto.createHash('sha256').update(JSON.stringify([hello.setName,[...hello.hosts].sort()])).digest('hex'):null};
 }catch(error){return {checks:[check(kind+'_database_probe',false,'Database connection, authentication or read-only probe failed ('+(/^[A-Za-z][A-Za-z0-9]{0,50}$/.test(error.name||'')?error.name:'Error')+').')],principalFingerprint:null,topologyFingerprint:null};}
 finally{if(connection)await connection.close().catch(()=>{});}
}
async function inspectPublic(origin,{fetchImpl=fetch}={}){
 const probes=[['https_readiness','/health/ready'],['public_home','/'],['robots_policy','/robots.txt'],['public_sitemap','/sitemap.xml'],['ai_content_guide','/llms.txt'],['private_dashboard','/tenant/dashboard']];
 return Promise.all(probes.map(async([name,path])=>{
  try{
   const response=await fetchImpl(origin+path,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'User-Agent':'ClassicFin-Launch-Readiness/1.0'}});
   let passed=response.status===200;
   if(path==='/health/ready')passed=passed&&(await response.json()).status==='ready';
   if(path==='/')passed=passed&&/max-age=[1-9]\d*/i.test(response.headers.get('strict-transport-security')||'');
   if(path==='/robots.txt'){const body=await response.text();passed=passed&&/Disallow:\s*\/tenant/i.test(body)&&/Disallow:\s*\/platform/i.test(body)&&!/^Disallow:\s*\/\s*$/im.test(body);}
   if(path==='/sitemap.xml'){const body=await response.text();passed=passed&&body.includes(origin)&&!/<loc>[^<]*\/(?:signin|signup|tenant|platform)(?:[/?<])/i.test(body);}
   if(path==='/llms.txt')passed=passed&&(await response.text()).trim().length>100;
   if(path==='/tenant/dashboard')passed=[301,302,303,401,403].includes(response.status)&&/no-store/i.test(response.headers.get('cache-control')||'')&&/noindex|none/i.test(response.headers.get('x-robots-tag')||'');
   return check(name,passed,passed?undefined:'The deployed HTTPS response did not meet the launch contract.');
  }catch(error){return check(name,false,'HTTPS probe failed ('+(error.name||'Error')+').');}
 }));
}
async function inspect(input,{live=true,connect,fetchImpl}={}){
 const config=configurationChecks(input),checks=[...config.checks],configurationValid=checks.every(entry=>entry.passed);
 if(live&&configurationValid){
  const dbs=await Promise.all([inspectMongo(require('../../config/mongoUris').platformUri(input),{kind:'web',connect}),inspectMongo(input.MONGO_WORKER_URI,{kind:'outbox',connect}),inspectMongo(input.MONGO_NOTIFICATION_WORKER_URI,{kind:'notification',connect}),...(input.TENANT_BACKUPS_ENABLED==='true'?[inspectMongo(input.MONGO_BACKUP_WORKER_URI,{kind:'backup',connect})]:[])]);
  checks.push(...dbs.flatMap(result=>result.checks),check('same_live_replica_set',dbs.every(result=>result.topologyFingerprint)&&new Set(dbs.map(result=>result.topologyFingerprint)).size===1,'Web and both workers must connect to the same actual replica set.'),check('distinct_authenticated_service_principals',dbs.every(result=>result.principalFingerprint)&&new Set(dbs.map(result=>result.principalFingerprint)).size===dbs.length,'The live database connections must authenticate as distinct service principals.'),...await inspectPublic(config.origin,{fetchImpl}));
 }
 const manualVerificationRequired=[...MANUAL_EVIDENCE];
 if(input.TENANT_BACKUPS_ENABLED==='true')manualVerificationRequired.push('Connect a real tenant Google Drive, verify quota-failure fallback and archive decryption, confirm the persistent volume and independent monitoring, and observe closing-time scheduling on the actual deployment.');
 if(input.TRANSFER_SMS_PROVIDER==='twilio')manualVerificationRequired.push('Confirm receiver SMS reaches a controlled real handset, then verify the sender-phone/PIN payout and inspect provider acceptance separately from receipt.');
 return {event:'production.readiness',mode:live?'live-read-only':'configuration-only',configurationValid,automatedChecksPassed:configurationValid&&(!live||checks.every(entry=>entry.passed)),liveChecksCompleted:live&&configurationValid,checks,manualVerificationRequired,productionCertification:false};
}
module.exports={configurationChecks,inspectMongo,inspectPublic,inspect,FORBIDDEN_ROLES,MANUAL_EVIDENCE};
