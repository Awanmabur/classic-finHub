'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const path=require('node:path');
const fsp=require('node:fs/promises');
const {EventEmitter}=require('node:events');
const alert=require('../src/platform/services/ops-alert.service');
const {loadSecretToken}=require('../src/platform/services/ops-token.service');
test('operational incidents exclude tenant and financial details',()=>{
 const payload=alert.buildAlert('backup-failure');
 assert.equal(payload.severity,'critical');
 assert.deepEqual(Object.keys(payload),['service','severity','event','occurredAt','action']);
 assert.throws(()=>alert.buildAlert('arbitrary-content'));
});
test('webhook URL requires HTTPS and forbids embedded secrets',()=>{
 for(const url of ['http://example.com/alerts','https://user:pass@example.com/','https://example.com/hook?token=secret','https://127.0.0.1/hook','https://example.com:8443/hook'])assert.throws(()=>alert.validateAlertUrl(url));
 assert.equal(alert.validateAlertUrl('https://alerts.example.com/incident').protocol,'https:');
});
test('alert delivery checks provider HTTP status, sends sanitized JSON and bearer header',async()=>{
 let captured;
 const transport={request(_url,options,onResponse){
  captured=options;
  const req=new EventEmitter();req.end=data=>{
   const body=JSON.parse(data);assert.equal(body.event,'offsite-failure');
   const res=new EventEmitter();res.statusCode=202;res.resume=()=>{};
   onResponse(res);process.nextTick(()=>res.emit('end'));
  };return req;
 }};
 const output=await alert.postAlert({url:'https://alerts.example.com/incident',token:'t'.repeat(32),alert:alert.buildAlert('offsite-failure'),transport});
 assert.equal(output.acceptedByEndpoint,true);
 assert.equal(captured.headers.Authorization,`Bearer ${'t'.repeat(32)}`);
});
test('alert token must be private, regular and sufficiently long',async t=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'cfh-ops-test-'));t.after(async()=>fsp.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'token');await fsp.writeFile(file,'a'.repeat(32),{mode:0o600});
 assert.equal(await loadSecretToken(file),'a'.repeat(32));
 if(process.platform!=='win32'){
  await fsp.chmod(file,0o644);
  await assert.rejects(()=>loadSecretToken(file),/owner-only/);
 }
});
