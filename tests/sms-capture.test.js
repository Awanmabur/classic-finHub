'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');
const secure=require('../src/tenant/services/smsCrypto.service');
const capture=require('../src/tenant/services/smsCapture.service');
const {modules,plans}=require('../src/data/store');

const NOW=Date.UTC(2026,10,5,12);
const KEY='14'.repeat(32);
function withKey(fn,value=KEY){
  const previous=process.env.MFA_ENCRYPTION_KEY;
  if(value===undefined)delete process.env.MFA_ENCRYPTION_KEY;else process.env.MFA_ENCRYPTION_KEY=value;
  try{return fn();}finally{
    if(previous===undefined)delete process.env.MFA_ENCRYPTION_KEY;else process.env.MFA_ENCRYPTION_KEY=previous;
  }
}
function signature(secret,body,timestamp){
  return crypto.createHmac('sha256',Buffer.from(secret,'hex')).update(`${timestamp}.`).update(body).digest('hex');
}
function envelope(){return {messageId:'android-01:1700000000000',sender:' MTN ',receivedAt:new Date(NOW-1000).toISOString(),body:'Example provider confirmation'};}
function activeTenant(){
  return {status:'active',plan:'sms_agent',enabledModules:['mobile_money','sms_capture'],subscription:{
    status:'granted',planCode:'sms_agent',planVersion:1,generation:1,
    periodStart:new Date(Date.now()-86400000),periodEnd:new Date(Date.now()+86400000),
    modules:['mobile_money','sms_capture'],limits:{users:10,branches:2,transactionsPerMonth:100,smsPerMonth:100,storageMb:500}
  }};
}
function operator(){return {id:'1234567890abcdef12345678',role:'Mobile Money Operator',allowedModules:['mobile_money','sms_capture']};}
function denied(fn){assert.throws(fn,error=>error.status===403);}

test('SMS encrypted data uses random IVs and authenticates its device/message context',()=>withKey(()=>{
  const plaintext='Secret SMS contents',context='sms:device123:message456';
  const first=secure.encrypt(plaintext,context),second=secure.encrypt(plaintext,context);
  assert.notEqual(first,second);
  assert.equal(secure.decrypt(first,context),plaintext);
  assert.equal(secure.decrypt(second,context),plaintext);
  assert(!first.includes(plaintext));
  assert.throws(()=>secure.decrypt(first,'sms:other-device:message456'),error=>error.status===503);
  const parts=first.split('.');
  parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
  assert.throws(()=>secure.decrypt(parts.join('.'),context),error=>error.status===503);
  assert.throws(()=>withKey(()=>secure.decrypt(first,context),'26'.repeat(32)),error=>error.status===503);
}));

test('SMS encryption derives a separate key from the MFA master key',()=>withKey(()=>{
  const encrypted=secure.encrypt('relay credential','device:abc');
  const [iv,tag,body]=encrypted.split('.').map(value=>Buffer.from(value,'base64url'));
  const rawKeyDecipher=crypto.createDecipheriv('aes-256-gcm',Buffer.from(KEY,'hex'),iv);
  rawKeyDecipher.setAAD(Buffer.from('device:abc'));rawKeyDecipher.setAuthTag(tag);
  assert.throws(()=>Buffer.concat([rawKeyDecipher.update(body),rawKeyDecipher.final()]));
  const derived=crypto.createHmac('sha256',Buffer.from(KEY,'hex')).update('classicfin:sms-capture:v1').digest();
  const smsDecipher=crypto.createDecipheriv('aes-256-gcm',derived,iv);
  smsDecipher.setAAD(Buffer.from('device:abc'));smsDecipher.setAuthTag(tag);
  assert.equal(Buffer.concat([smsDecipher.update(body),smsDecipher.final()]).toString(),'relay credential');
}));

test('missing encryption configuration and malformed encrypted values fail closed',()=>{
  assert.throws(()=>withKey(()=>secure.encrypt('secret','device:id'),''),error=>error.status===503);
  for(const value of ['','a.b.c','not-encrypted',null]){
    assert.throws(()=>withKey(()=>secure.decrypt(value,'device:id')),error=>error.status===503);
  }
});

test('HMAC binds the exact raw JSON bytes and the signed timestamp',()=>{
  const secret='af'.repeat(32),body=Buffer.from('{"messageId":"sms-1","body":"confirmed"}');
  const timestamp=String(NOW/1000),signed=signature(secret,body,timestamp);
  assert.equal(secure.verifySignature(secret,body,timestamp,signed,NOW),true);
  assert.equal(secure.verifySignature(secret,Buffer.from('{ "messageId":"sms-1","body":"confirmed"}'),timestamp,signed,NOW),false);
  assert.equal(secure.verifySignature(secret,Buffer.from('{"messageId":"sms-1","body":"changed"}'),timestamp,signed,NOW),false);
  assert.equal(secure.verifySignature(secret,body,String(Number(timestamp)+1),signed,NOW),false);
  assert.equal(secure.verifySignature('ab'.repeat(32),body,timestamp,signed,NOW),false);
  assert.equal(secure.verifySignature(secret,body.toString(),timestamp,signed,NOW),false);
});

test('HMAC rejects stale, future, malformed and truncated credentials',()=>{
  const secret='af'.repeat(32),body=Buffer.from('{}'),timestamp=String(NOW/1000);
  const signed=signature(secret,body,timestamp);
  assert.equal(secure.verifySignature(secret,body,timestamp,signed,NOW+300000),true);
  assert.equal(secure.verifySignature(secret,body,timestamp,signed,NOW+300001),false);
  assert.equal(secure.verifySignature(secret,body,timestamp,signed,NOW-300001),false);
  for(const invalid of ['',null,`${timestamp}.0`,'123','1'.repeat(20)]){
    assert.equal(secure.verifySignature(secret,body,invalid,signed,NOW),false);
  }
  for(const invalid of ['',null,signed.slice(1),'z'.repeat(64),'0'.repeat(64)]){
    assert.equal(secure.verifySignature(secret,body,timestamp,invalid,NOW),false);
  }
});

test('message idempotency key is a stable UUID scoped to both device and message',()=>{
  const a='a'.repeat(32),b='b'.repeat(32),message='android:01:1234';
  const first=secure.idempotencyKey(a,message);
  assert.match(first,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(first,secure.idempotencyKey(a,message));
  assert.notEqual(first,secure.idempotencyKey(b,message));
  assert.notEqual(first,secure.idempotencyKey(a,message+'5'));
});

test('payload validation accepts the documented envelope and normalizes only sender/time',()=>{
  assert.deepEqual(capture.validatePayload(envelope(),NOW),{...envelope(),sender:'MTN'});
  const seconds={...envelope(),receivedAt:new Date(NOW-1000).toISOString().replace('.000','')};
  assert.equal(capture.validatePayload(seconds,NOW).receivedAt,new Date(NOW-1000).toISOString());
  assert.equal(capture.validatePayload({...envelope(),body:'A'.repeat(2000)},NOW).body.length,2000);
});

test('payload validation rejects unknown routing fields, wrong types and oversized content',()=>{
  const invalid=[null,[],{},'message',
    {...envelope(),tenantId:'another-tenant'}, {...envelope(),branchId:'another-branch'},
    {...envelope(),messageId:42}, {...envelope(),messageId:''}, {...envelope(),messageId:'id with spaces'},
    {...envelope(),messageId:'a'.repeat(129)}, {...envelope(),sender:[]}, {...envelope(),sender:''},
    {...envelope(),sender:'\nMTN'}, {...envelope(),sender:'A'.repeat(41)},
    {...envelope(),body:{}}, {...envelope(),body:''}, {...envelope(),body:'A'.repeat(2001)},
    {...envelope(),body:'private\u0000message'}, {...envelope(),receivedAt:NOW}];
  for(const input of invalid)assert.throws(()=>capture.validatePayload(input,NOW),error=>error.status===400);
});

test('payload rejects expired, future, impossible-calendar and blank-sender envelopes',()=>{
  const invalid=[
    {...envelope(),receivedAt:new Date(NOW-capture.RETENTION_MS-1).toISOString()},
    {...envelope(),receivedAt:new Date(NOW+300001).toISOString()},
    {...envelope(),receivedAt:'not-a-date'}, {...envelope(),receivedAt:'2026-11-05'},
    {...envelope(),receivedAt:'2026-11-05T12:00:00+00:00'},
    {...envelope(),receivedAt:'2026-11-05T12:00:00.000Zextra'},
    {...envelope(),sender:'   '}
  ];
  for(const input of invalid)assert.throws(()=>capture.validatePayload(input,NOW),error=>error.status===400);
  assert.throws(()=>capture.validatePayload({...envelope(),receivedAt:'2026-02-30T12:00:00.000Z'},Date.UTC(2026,2,2,12)),error=>error.status===400);
});

test('sender allowlist is explicit, normalized, unique and bounded',()=>{
  assert.deepEqual(capture.senders('MTN, Airtel, +256700000000'),['MTN','AIRTEL','+256700000000']);
  for(const value of [null,[],42,'','   ','MTN,mtn','MTN\nInjected','<script>','x'.repeat(301),Array.from({length:9},(_,i)=>`Sender${i}`).join(',')]){
    assert.throws(()=>capture.senders(value),error=>error.status===400);
  }
});

test('premium SMS entitlement requires an active paid/trial plan, both modules and staff assignments',()=>{
  const tenant=activeTenant(),actor=operator();
  assert.equal(capture.entitlement(tenant,actor),tenant.subscription);
  const trial=activeTenant();trial.status='trial';trial.subscription.status='trial';
  assert.equal(capture.entitlement(trial,actor),trial.subscription);
  assert.equal(capture.entitlement(tenant,{id:actor.id,role:'Tenant Owner'}),tenant.subscription);
  for(const status of ['suspended','past_due']){const t=activeTenant();t.status=status;denied(()=>capture.entitlement(t,actor));}
  for(const missing of ['mobile_money','sms_capture']){
    const t=activeTenant();t.subscription.modules=t.subscription.modules.filter(key=>key!==missing);
    denied(()=>capture.entitlement(t,actor));
    const t2=activeTenant();t2.enabledModules=t2.enabledModules.filter(key=>key!==missing);
    denied(()=>capture.entitlement(t2,actor));
    denied(()=>capture.entitlement(tenant,{...actor,allowedModules:actor.allowedModules.filter(key=>key!==missing)}));
  }
  for(const quota of [0,-1,undefined,'100']){const t=activeTenant();t.subscription.limits.smsPerMonth=quota;denied(()=>capture.entitlement(t,actor));}
  const expired=activeTenant();expired.subscription.periodEnd=new Date(Date.now()-1000);denied(()=>capture.entitlement(expired,actor));
  const revoked=activeTenant();revoked.subscription.status='revoked';denied(()=>capture.entitlement(revoked,actor));
  denied(()=>capture.entitlement(tenant,null));
  assert(modules.some(module=>module.key==='sms_capture'&&module.priceMonthly>modules.find(module=>module.key==='mobile_money').priceMonthly));
  assert(plans.every(plan=>!plan.modules.includes('sms_capture')),'legacy manual plans must never silently gain automatic SMS capture');
});

test('SMS detail escapes raw messages and shows confirmation only for authorized editable drafts',()=>{
  const template=fs.readFileSync(path.join(__dirname,'../src/views/tenant/sms/detail.ejs'),'utf8');
  const draft={_id:'1234567890abcdef12345678',state:'needs_review',sender:'<img src=x onerror=alert(1)>',
    body:'<script>alert("private SMS")</script>',reasonCode:'unsupported_format',
    receivedAt:new Date(NOW),expiresAt:new Date(NOW+86400000),fields:{customer:'\" autofocus onfocus=alert(1) x=\"'}};
  const render=(canConfirm,state='needs_review')=>ejs.render(template,{data:{draft:{...draft,state},canConfirm},csrfToken:'csrf-value'});
  const authorized=render(true);
  assert(!authorized.includes('<script>alert('));assert(authorized.includes('&lt;script&gt;'));
  assert(!authorized.includes('<img src=x'));assert(authorized.includes('&lt;img'));
  assert(authorized.includes('&#34; autofocus'));
  assert(authorized.includes(`/tenant/sms-capture/${draft._id}/confirm`));
  assert(!render(false).includes(`/tenant/sms-capture/${draft._id}/confirm`));
  assert(!render(true,'recorded').includes(`/tenant/sms-capture/${draft._id}/confirm`));
  assert(!render(true,'dismissed').includes(`/tenant/sms-capture/${draft._id}/confirm`));
});
