'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const backup=require('../src/platform/services/backup.service');
const payload=Buffer.from('CFH archive dummy mongo dump fixture data - not a real financial backup.');
async function fixture(t){
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'cfh-backup-test-'));
 await fsp.chmod(dir,0o700);
 t.after(async()=>fsp.rm(dir,{recursive:true,force:true}));
 const executable=path.join(dir,'fake-mongodump.js');
 await fsp.writeFile(executable,`#!/usr/bin/env node\nconst fs=require('fs');\nif(!process.argv.includes('--oplog')||!process.argv.includes('--archive')||!process.argv.includes('--gzip'))process.exit(3);\nconst config=fs.readFileSync(process.argv[process.argv.indexOf('--config')+1],'utf8');\nif(!config.includes('mongodb://'))process.exit(4);\nprocess.stdout.write(Buffer.from(${JSON.stringify(payload.toString('base64'))},'base64'));\n`,{mode:0o700});
 await fsp.chmod(executable,0o700);
 const key=crypto.randomBytes(32);
 return {dir,executable,key};
}
test('backup refuses a single-database source URI; includes all logical tenants',()=>{
 assert.throws(()=>backup.validateSourceUri('mongodb://localhost:27018/classicfin_platform_db?replicaSet=rs0'),/full replica-set/);
 assert.equal(backup.validateSourceUri('mongodb://localhost:27018/?replicaSet=rs0'),'mongodb://localhost:27018/?replicaSet=rs0');
});
test('restore target cannot point at production, developer port or an arbitrary replica set',()=>{
 for(const uri of ['mongodb://db.example.com:27019/?replicaSet=rs-restore','mongodb://127.0.0.1:27018/?replicaSet=rs-restore', 'mongodb://127.0.0.1:27019/?replicaSet=rs0','mongodb://127.0.0.1:27019/classicfin_platform_db?replicaSet=rs-restore'])
  assert.throws(()=>backup.assertSafeRestoreTarget(uri));
 assert.doesNotThrow(()=>backup.assertSafeRestoreTarget('mongodb://127.0.0.1:27019/admin?replicaSet=rs-restore&directConnection=true'));
});
test('full archive is encrypted, private, authenticated, and survives verification',async t=>{
 const {dir,executable,key}=await fixture(t);
 const result=await backup.createBackup({sourceUri:'mongodb://localhost:27018/?replicaSet=rs0',outputDir:dir,key,dumpBinary:executable});
 assert.ok(result.encrypted && result.oplog);
 assert.match(result.filename,/\.cfhb$/);
 const encrypted=await fsp.readFile(result.filename);
 assert.equal(encrypted.includes(payload),false);
 assert.ok(encrypted.subarray(0,8).equals(backup.MAGIC));
 // Windows exposes synthetic POSIX mode bits; ACL checks are a separate OS control.
 if(process.platform !== 'win32') assert.equal((await fsp.stat(result.filename)).mode & 0o077, 0);
 const verified=await backup.verifyBackup({filename:result.filename,key});
 assert.equal(verified.plaintextBytes,payload.length);
 const badKey=crypto.randomBytes(32);
 await assert.rejects(()=>backup.verifyBackup({filename:result.filename,key:badKey}));
 const tampered=Buffer.from(encrypted);tampered[25]^=1;
 const tamperedPath=path.join(dir,'tampered.cfhb');await fsp.writeFile(tamperedPath,tampered);
 await assert.rejects(()=>backup.verifyBackup({filename:tamperedPath,key}));
});
test('mongodump failures cannot publish an apparently successful backup',async t=>{
 const {dir,key}=await fixture(t);
 const executable=path.join(dir,'broken-mongodump.js');
 await fsp.writeFile(executable,'#!/usr/bin/env node\nprocess.stdout.write("partial");process.exitCode=2;\n',{mode:0o700});
 await fsp.chmod(executable,0o700);
 await assert.rejects(()=>backup.createBackup({sourceUri:'mongodb://localhost:27018/',outputDir:dir,key,dumpBinary:executable}),/mongodump failed/);
 const files=await fsp.readdir(dir);
 assert.equal(files.filter(name=>name.endsWith('.cfhb')||name.endsWith('.partial')).length,0);
});
test('rehearsal requires explicit isolated target and verified bytes before launching mongorestore',async t=>{
 const {dir,executable,key}=await fixture(t);
 const result=await backup.createBackup({sourceUri:'mongodb://localhost:27018/',outputDir:dir,key,dumpBinary:executable});
 const restoredOutput=path.join(dir,'restored.bin');
 const restoreBin=path.join(dir,'fake-mongorestore.js');
 await fsp.writeFile(restoreBin,`#!/usr/bin/env node\nconst fs=require('fs');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>fs.writeFileSync(${JSON.stringify(restoredOutput)},Buffer.concat(chunks)));\n`,{mode:0o700});
 await fsp.chmod(restoreBin,0o700);
 const uri='mongodb://127.0.0.1:27019/admin?replicaSet=rs-restore';
 let checked=0;
 await backup.rehearseBackup({filename:result.filename,key,targetUri:uri,restoreBinary:restoreBin,checkTarget:async () => {checked++;},inspectData:async()=>({tenantDatabasesVerified:1})});
 assert.equal(checked,1);
 assert.deepEqual(await fsp.readFile(restoredOutput),payload);
 const bytes=await fsp.readFile(result.filename);bytes[bytes.length-1]^=1;await fsp.writeFile(result.filename,bytes);
 await fsp.rm(restoredOutput);
 await assert.rejects(()=>backup.rehearseBackup({filename:result.filename,key,targetUri:uri,restoreBinary:restoreBin,checkTarget:async()=>{},inspectData:async()=>({tenantDatabasesVerified:1})}));
 await assert.rejects(()=>fsp.access(restoredOutput));
});
test('encryption key rejects loose permissions and invalid size',async t=>{
 const {dir}=await fixture(t);
 const file=path.join(dir,'key');
 await fsp.writeFile(file,'abcd',{mode:0o600});
 await assert.rejects(()=>backup.loadEncryptionKey(file),/32 random bytes/);
 await fsp.writeFile(file,crypto.randomBytes(32).toString('hex'),{mode:0o600});
 assert.equal((await backup.loadEncryptionKey(file)).length,32);
 if(process.platform!=='win32'){
  await fsp.chmod(file,0o644);
  await assert.rejects(()=>backup.loadEncryptionKey(file),/chmod 600/);
 }
});
test('backup-health requires a recent authenticated snapshot, never a partial file',async t=>{
 const {dir,executable,key}=await fixture(t);
 const {checkBackupHealth}=require('../src/platform/services/backup-health.service');
 await assert.rejects(()=>checkBackupHealth({directory:dir,key}),/No full/);
 const result=await backup.createBackup({sourceUri:'mongodb://localhost:27018/',outputDir:dir,key,dumpBinary:executable});
 const healthy=await checkBackupHealth({directory:dir,key,maxAgeHours:26});
 assert.equal(healthy.authenticated,true);
 await assert.rejects(()=>checkBackupHealth({directory:dir,key,maxAgeHours:1,now:new Date(Date.now()+3*3600000)}),/exceeds/);
 const bad=await fsp.readFile(result.filename);bad[40]^=1;await fsp.writeFile(result.filename,bad);
 await assert.rejects(()=>checkBackupHealth({directory:dir,key}));
});

test('restored application uniqueness checks reject missing, compound and nonunique indexes',()=>{
  const hasUnique=backup.hasUniqueSingleFieldIndex;
  assert.equal(hasUnique([{unique:true,key:{email:1}}],'email'),true);
  assert.equal(hasUnique([{unique:false,key:{email:1}}],'email'),false);
  assert.equal(hasUnique([{unique:true,key:{email:1,kind:1}}],'email'),false);
  assert.equal(hasUnique([{unique:true,key:{other:1}}],'email'),false);
});
