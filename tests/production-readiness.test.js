'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const readiness=require('../src/platform/services/productionReadiness.service');
const config=()=>({NODE_ENV:'production',APP_URL:'https://finance.acme.ug',PORT:'3000',TRUST_PROXY:'1',SESSION_SECRET:'session-'+('2d'.repeat(32)),MFA_ENCRYPTION_KEY:'8c'.repeat(32),REAL_MONEY_ENABLED:'false',RESEND_API_KEY:'provider-secret-for-test',MAIL_FROM:'ClassicFin <support@acme.ug>',MONGO_PLATFORM_URI:'mongodb://web:private-web@db-a:27017,db-b:27017/platform?replicaSet=rs0&tls=true',MONGO_WORKER_URI:'mongodb://outbox:private-worker@db-a:27017,db-b:27017/platform?replicaSet=rs0&tls=true',MONGO_NOTIFICATION_WORKER_URI:'mongodb://notifications:private-notify@db-a:27017,db-b:27017/platform?replicaSet=rs0&tls=true'});
test('launch configuration supports real multi-host TLS Mongo URIs without exposing credentials',()=>{
 const input=config(),report=readiness.configurationChecks(input);assert(report.checks.every(check=>check.passed),JSON.stringify(report));
 for(const option of ['tlsInsecure','tlsAllowInvalidCertificates','tlsAllowInvalidHostnames']){const checks=readiness.configurationChecks({...input,MONGO_PLATFORM_URI:input.MONGO_PLATFORM_URI+'&'+option+'=true'}).checks;assert(checks.some(check=>check.name==='mongo_platform_uri_tls'&&!check.passed),'insecure certificate options must block launch');}
 const output=JSON.stringify(report);for(const secret of [input.SESSION_SECRET,input.MFA_ENCRYPTION_KEY,input.RESEND_API_KEY,'private-web','private-worker','private-notify'])assert(!output.includes(secret));
 for(const bad of [{APP_URL:'https://replace.example'},{APP_URL:'https://example.com'},{APP_URL:'https://127.0.0.1'},{NODE_ENV:'development'},{MONGO_PLATFORM_URI:'mongodb://web:secret@db/platform?tls=false'},{MONGO_WORKER_URI:input.MONGO_PLATFORM_URI},{REAL_MONEY_ENABLED:'true'},{TRUST_PROXY:'0'},{MONGO_PLATFORM_URI:'mongodb://db/'},{MFA_ENCRYPTION_KEY:'0'.repeat(64)}])assert(readiness.configurationChecks({...input,...bad}).checks.some(check=>!check.passed));
});
test('configuration-only checks cannot claim live launch verification',async()=>{
 const report=await readiness.inspect(config(),{live:false,connect:()=>{throw Error('must not connect');}});
 assert.equal(report.automatedChecksPassed,true);assert.equal(report.liveChecksCompleted,false);assert.equal(report.productionCertification,false);assert(report.manualVerificationRequired.length>=4);
 const blocked=await readiness.inspect({}, {connect:()=>{throw Error('must not connect with invalid configuration');}});assert.equal(blocked.automatedChecksPassed,false);
});
test('production probe honors the platform alias and rejects incompatible base URIs before connecting',async()=>{
 const input=config();input.PLATFORM_DB_URI=input.MONGO_PLATFORM_URI;delete input.MONGO_PLATFORM_URI;
 assert(readiness.configurationChecks(input).checks.every(check=>check.passed));
 let connections=0;
 const bad=await readiness.inspect({...input,MONGO_URI_BASE:'mongodb://elsewhere:27017/?tls=true'},{connect:async()=>{connections++;throw Error('must not connect');}});
 assert.equal(bad.configurationValid,false);assert.equal(connections,0);
 assert(bad.checks.some(check=>check.name==='mongo_alias_and_base_configuration'&&!check.passed));
});
test('receiver SMS readiness requires complete worker settings and an independent key without leaking credentials',()=>{
 const input={...config(),TRANSFER_SMS_PROVIDER:'twilio',TRANSFER_SMS_ENCRYPTION_KEY:'37'.repeat(32),TWILIO_ACCOUNT_SID:'AC'+'ab'.repeat(16),TWILIO_AUTH_TOKEN:'c8'.repeat(16),TWILIO_FROM_NUMBER:'+256700123456'};
 const valid=readiness.configurationChecks(input);assert(valid.checks.every(check=>check.passed),JSON.stringify(valid));
 for(const invalid of [{TWILIO_AUTH_TOKEN:''},{TRANSFER_SMS_ENCRYPTION_KEY:''},{TWILIO_FROM_NUMBER:'invalid'},{TWILIO_MESSAGING_SERVICE_SID:'MG'+'ef'.repeat(16)},{TRANSFER_SMS_PROVIDER:'unknown'},{TRANSFER_SMS_ENCRYPTION_KEY:input.MFA_ENCRYPTION_KEY.toUpperCase()},{TRANSFER_SMS_ENCRYPTION_KEY:'0'.repeat(64)}])assert(readiness.configurationChecks({...input,...invalid}).checks.some(check=>!check.passed));
 const report=JSON.stringify(valid);for(const secret of [input.TRANSFER_SMS_ENCRYPTION_KEY,input.TWILIO_AUTH_TOKEN,input.TWILIO_ACCOUNT_SID,input.TWILIO_FROM_NUMBER])assert(!report.includes(secret));
});
function connection({user='web',kind='outbox',active=true,roles=[],dead=0}={}){
 return {db:{admin:()=>({command:async()=>({setName:'rs0',isWritablePrimary:true,hosts:['db-a:27017','db-b:27017']})}),command:async()=>({authInfo:{authenticatedUsers:user?[{user,db:'admin'}]:[],authenticatedUserRoles:roles.map(role=>({role,db:'admin'}))}}),collection:name=>({countDocuments:async query=>{
  if(name==='workerheartbeats')return active&&query.workerId.test(kind+'-test')?1:0;
  return query.state==='dead'?dead:0;
 }})},close:async()=>{}};
}
test('read-only live checks distinguish outbox from notification workers and reject unauthenticated/admin database access',async()=>{
 const wrong=await readiness.inspectMongo('unused',{kind:'outbox',connect:async()=>connection({kind:'notification'})});assert(wrong.checks.some(check=>check.name==='outbox_worker_heartbeat'&&!check.passed));
 for(const values of [{user:''},{roles:['root']},{roles:['atlasAdmin']},{roles:['readWriteAnyDatabase']},{roles:['readAnyDatabase']},{dead:1}]){
  const result=await readiness.inspectMongo('unused',{kind:'outbox',connect:async()=>connection(values)});assert(result.checks.some(check=>!check.passed));
 }
 const good=await readiness.inspectMongo('unused',{kind:'outbox',connect:async()=>connection()});assert(good.checks.every(check=>check.passed));
 const failure=await readiness.inspectMongo('unused',{connect:async()=>{throw Error('mongodb://name:DO-NOT-LEAK@host/db');}});assert(!JSON.stringify(failure).includes('DO-NOT-LEAK'));
});
function publicFetch(url){
 const pathname=new URL(url).pathname,headers=new Headers();
 if(pathname==='/')headers.set('strict-transport-security','max-age=31536000');
 if(pathname==='/tenant/dashboard'){headers.set('cache-control','no-store');headers.set('x-robots-tag','noindex,nofollow');return Promise.resolve(new Response(null,{status:303,headers}));}
 const body=pathname==='/health/ready'?JSON.stringify({status:'ready'}):pathname==='/robots.txt'?'User-agent: *\nDisallow: /tenant\nDisallow: /platform\n':pathname==='/sitemap.xml'?'<urlset><loc>https://finance.acme.ug/</loc></urlset>':pathname==='/llms.txt'?'# Public finance operations documentation\n'+'Public product information. '.repeat(8):'<html>Public home</html>';
 return Promise.resolve(new Response(body,{status:200,headers}));
}
test('public live probes require private noindex/no-store, HTTPS readiness and intentional crawler access',async()=>{
 const checks=await readiness.inspectPublic('https://finance.acme.ug',{fetchImpl:publicFetch});assert(checks.every(check=>check.passed));
 const leaked=await readiness.inspectPublic('https://finance.acme.ug',{fetchImpl:async()=>new Response('private data',{status:200})});assert(leaked.some(check=>check.name==='private_dashboard'&&!check.passed));
 const samePrincipal=await readiness.inspect(config(),{connect:async()=>connection({user:'same',kind:'notification'}),fetchImpl:publicFetch});assert(samePrincipal.checks.some(check=>check.name==='distinct_authenticated_service_principals'&&!check.passed));
});
