'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const encryption=require('../src/tenant/transferSms/crypto'),provider=require('../src/tenant/transferSms/provider'),service=require('../src/tenant/transferSms/service');
const {schema}=require('../src/tenant/transferSms/models');
function configured(work){const names=['TRANSFER_SMS_PROVIDER','TRANSFER_SMS_ENCRYPTION_KEY','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM_NUMBER','TWILIO_MESSAGING_SERVICE_SID'],saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));Object.assign(process.env,{TRANSFER_SMS_PROVIDER:'twilio',TRANSFER_SMS_ENCRYPTION_KEY:'15'.repeat(32),TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),TWILIO_AUTH_TOKEN:'b'.repeat(32),TWILIO_FROM_NUMBER:'+256700111222'});delete process.env.TWILIO_MESSAGING_SERVICE_SID;return Promise.resolve().then(work).finally(()=>{for(const name of names)if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];});}
const message={to:'+256700123456',body:'ClassicFin: PIN 104932. Sender +256700654321. UGX 10000. Collect at Main after identity checks.'};
test('SMS ciphertext protects PIN and complete recipient, rejects tampering and a different tenant/execution binding',()=>configured(()=>{
 const binding='tenantdb:tenant:execution:source',ciphertext=encryption.encrypt(message,binding);
 assert(!ciphertext.includes(message.to));assert(!ciphertext.includes('104932'));assert.deepEqual(encryption.decrypt(ciphertext,binding),message);
 assert.throws(()=>encryption.decrypt(ciphertext,'otherdb:tenant:execution:source'));
 const parts=ciphertext.split('.');parts[1]=(parts[1][0]==='a'?'b':'a')+parts[1].slice(1);assert.throws(()=>encryption.decrypt(parts.join('.'),binding));
 delete process.env.TRANSFER_SMS_ENCRYPTION_KEY;assert.equal(encryption.configured(),false);assert.throws(()=>encryption.encrypt(message,binding),{code:'SMS_KEY_NOT_CONFIGURED'});
}));
test('provider configuration is explicit and limits sender identities to one configured number or messaging service',()=>configured(()=>{
 assert(provider.settings());process.env.TWILIO_MESSAGING_SERVICE_SID='MG'+'c'.repeat(32);assert.throws(()=>provider.settings(),{code:'SMS_PROVIDER_NOT_CONFIGURED'});
 delete process.env.TWILIO_FROM_NUMBER;assert.equal(provider.settings().service,'MG'+'c'.repeat(32));
 process.env.TWILIO_MESSAGING_SERVICE_SID='https://untrusted.invalid/';assert.throws(()=>provider.settings(),{code:'SMS_PROVIDER_NOT_CONFIGURED'});
 process.env.TRANSFER_SMS_PROVIDER='none';assert.equal(provider.settings(),null);
}));
test('Twilio submission goes to the fixed TLS endpoint, does not follow redirects and returns only safe acceptance metadata',()=>configured(async()=>{
 let captured;
 const result=await provider.send(message,{fetcher:async(url,options)=>{captured={url,options};return new Response(JSON.stringify({sid:'SM'+'d'.repeat(32),status:'queued',to:message.to,body:message.body,secret:'discard-me'}),{status:201});}});
 assert.match(captured.url,/^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC[a-f0-9]{32}\/Messages\.json$/);assert.equal(captured.options.method,'POST');assert.equal(captured.options.redirect,'error');assert(captured.options.signal);
 assert.equal(new URLSearchParams(captured.options.body).get('To'),message.to);assert.equal(new URLSearchParams(captured.options.body).get('Body'),message.body);
 assert.deepEqual(result,{status:'accepted',messageId:'SM'+'d'.repeat(32),providerState:'queued'});assert(!JSON.stringify(result).includes('104932'));
}));
test('ambiguous external submission is never treated as safe to retry or as delivered',()=>configured(async()=>{
 for(const fetcher of [async()=>{throw new Error('sensitive upstream error '+message.body);},async()=>({status:408,ok:false}),async()=>({status:503,ok:false}),async()=>new Response(JSON.stringify({sid:'invalid',status:'queued'}),{status:201}),async()=>new Response('malformed',{status:201}),async()=>new Response('x'.repeat(16385),{status:201}),async()=>new Response('tiny',{status:201,headers:{'content-length':'999999'}})]){
  await assert.rejects(provider.send(message,{fetcher}),error=>error.code==='SMS_SUBMISSION_UNCERTAIN'&&!error.message.includes('104932')&&!error.message.includes(message.to));
 }
 await assert.rejects(provider.send(message,{fetcher:async()=>({status:429,ok:false})}),{code:'SMS_RATE_LIMITED'});
 await assert.rejects(provider.send(message,{fetcher:async()=>({status:400,ok:false})}),{code:'SMS_PROVIDER_REJECTED'});
}));
test('invalid recipient/body cannot reach the external adapter',()=>configured(async()=>{
 let requests=0;const fetcher=async()=>{requests++;throw new Error('should not send');};
 for(const invalid of [{...message,to:'0700123456'},{...message,to:message.to+'\n'},{...message,body:''},{...message,body:'a'.repeat(1201)},{...message,body:'PIN\x00secret'}])await assert.rejects(provider.send(invalid,{fetcher}),{code:'SMS_PAYLOAD_INVALID'});
 assert.equal(requests,0);
}));
test('redacted delivery summaries and schema never expose PIN, recipient, ciphertext or lease credentials',()=>{
 const row={_id:'id',state:'accepted',recipientMasked:'••••3456',payloadEncrypted:'secret ciphertext',to:message.to,body:message.body,leaseToken:'private-lease',attempts:1,revision:2};
 const exposed=service.publicRecord(row),serialized=JSON.stringify(exposed);for(const secret of ['104932',message.to,row.payloadEncrypted,row.leaseToken])assert(!serialized.includes(secret));
 assert.equal(schema.path('payloadEncrypted').options.select,false);assert.equal(schema.path('leaseToken').options.select,false);
 assert(!schema.path('to'));assert(!schema.path('body'));assert(schema.indexes().some(([fields,options])=>fields.executionId===1&&options.unique===true));
 assert.equal(service.classify(new Error(message.body)),'SMS_SUBMISSION_UNCERTAIN');assert.equal(service.classify({code:'SMS_RATE_LIMITED'}),'SMS_RATE_LIMITED');
});

test('web enqueue configuration needs the shared delivery key without receiving worker provider credentials',()=>{
 const web={TRANSFER_SMS_PROVIDER:'twilio',TRANSFER_SMS_ENCRYPTION_KEY:'25'.repeat(32)};
 assert.deepEqual(service.validateConfig(web),{enabled:true});assert.throws(()=>service.validateConfig(web,{worker:true}),{code:'SMS_PROVIDER_NOT_CONFIGURED'});
 assert.throws(()=>service.validateConfig({TRANSFER_SMS_PROVIDER:'twilio'}),{code:'SMS_KEY_NOT_CONFIGURED'});
 assert.throws(()=>service.validateConfig({TRANSFER_SMS_PROVIDER:'arbitrary-url'}),{code:'SMS_PROVIDER_NOT_CONFIGURED'});
 assert.deepEqual(service.validateConfig({TRANSFER_SMS_PROVIDER:'none'},{worker:true}),{enabled:false});
});
