'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const backup=require('../src/platform/services/backup.service');
const offsite=require('../src/platform/services/offsite-backup.service');

async function localFixture(t){
 const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'cfh-s3-test-'));
 await fsp.chmod(directory,0o700);
 t.after(async()=>fsp.rm(directory,{recursive:true,force:true}));
 const tool=path.join(directory,'mongodump-stub.js');
 await fsp.writeFile(tool,'#!/usr/bin/env node\nprocess.stdout.write(Buffer.alloc(500,42));\n',{mode:0o700});
 await fsp.chmod(tool,0o700);
 const key=crypto.randomBytes(32);
 const {filename}=await backup.createBackup({sourceUri:'mongodb://localhost:27018/',outputDir:directory,key,dumpBinary:tool});
 return {directory,key,filename};
}
const cfg={bucket:'classicfin-security-backup',expectedOwner:'123456789012',region:'eu-west-1',prefix:'classicfin/',retentionDays:90};
function fakeAws(){
 const calls=[];
 let object=null;
 const aws=async args=>{
  calls.push(args);
  const op=args[1];
  const value=k=>args[args.indexOf(k)+1];
  if(op==='get-bucket-versioning')return {Status:'Enabled'};
  if(op==='get-object-lock-configuration')return {ObjectLockConfiguration:{ObjectLockEnabled:'Enabled'}};
  if(op==='put-object'){
   object={VersionId:'version-1',ContentLength:fs.statSync(value('--body')).size,
    ChecksumSHA256:value('--checksum-sha256'),ObjectLockMode:value('--object-lock-mode'),
    ObjectLockRetainUntilDate:value('--object-lock-retain-until-date'),ServerSideEncryption:value('--server-side-encryption')};
   return {VersionId:'version-1'};
  }
  if(op==='head-object')return object;
  throw new Error(`Unexpected operation ${op}`);
 };
 return {aws,calls,setRemote:obj=>{object=obj;},getRemote:()=>object};
}
test('S3 configuration requires an AWS account, versioned bucket, legal retention and region',()=>{
 assert.throws(()=>offsite.safeConfig({...cfg,expectedOwner:''}),/12-digit/);
 assert.throws(()=>offsite.safeConfig({...cfg,retentionDays:3}),/30/);
 assert.throws(()=>offsite.safeConfig({...cfg,prefix:'../secret/'}),/PREFIX/);
 assert.throws(()=>offsite.safeConfig({...cfg,bucket:'127.0.0.1'}),/BUCKET/);
 assert.equal(offsite.safeConfig(cfg).bucket,cfg.bucket);
});
test('uploads authenticated ciphertext, requires S3 checksum, compliance lock, immutable version, and writes private receipt',async t=>{
 const {directory,key,filename}=await localFixture(t);
 const s3=fakeAws();
 const first=await offsite.publishBackup({filename,outputDir:directory,key,cfg,aws:s3.aws});
 assert.equal(first.status,'uploaded-and-verified');
 const put=s3.calls.find(x=>x[1]==='put-object');
 assert.ok(put.includes('--checksum-sha256'));
 assert.equal(put[put.indexOf('--object-lock-mode')+1],'COMPLIANCE');
 assert.ok(s3.calls.some(x=>x[1]==='head-object'));
 const receipt=path.join(directory,'receipts',path.basename(filename)+'.json');
 // Windows stat().mode cannot prove Unix 0600; keep this assertion on POSIX.
 if(process.platform !== 'win32') assert.equal((await fsp.stat(receipt)).mode&0o077,0);
 const second=await offsite.publishBackup({filename,outputDir:directory,key,cfg,aws:s3.aws});
 assert.equal(second.status,'verified-existing');
 assert.equal(s3.calls.filter(x=>x[1]==='put-object').length,1);
 const health=await offsite.verifyOffsiteHealth({directory,cfg,aws:s3.aws});
 assert.equal(health.complianceRetention,true);
 assert.equal(health.checksumVerified,true);
});
test('remote checksum mismatch or weak retention refuses a successful receipt',async t=>{
 const {directory,key,filename}=await localFixture(t);
 const s3=fakeAws();
 const original=s3.aws;
 const failAws=async args=>{
  const result=await original(args);
  if(args[1]==='head-object')return {...result,ChecksumSHA256:'invalid'};
  return result;
 };
 await assert.rejects(()=>offsite.publishBackup({filename,outputDir:directory,key,cfg,aws:failAws}),/checksum mismatch/);
 assert.equal((await fsp.readdir(path.join(directory,'receipts'))).length,0);
});
test('unversioned bucket rejects upload, and corrupted local archive is never replicated',async t=>{
 const {directory,key,filename}=await localFixture(t);
 let puts=0;
 await assert.rejects(()=>offsite.publishBackup({filename,outputDir:directory,key,cfg,aws:async args=>{
  if(args[1]==='put-object')puts++;
  if(args[1]==='get-bucket-versioning')return {Status:'Suspended'};
  return {};
 }}),/versioning Enabled/);
 assert.equal(puts,0);
 const contents=await fsp.readFile(filename);contents[70]^=1;await fsp.writeFile(filename,contents);
 await assert.rejects(()=>offsite.publishBackup({filename,outputDir:directory,key,cfg,aws:async()=>{puts++;return {};}}));
 assert.equal(puts,0);
});
test('offsite freshness reports missing receipts, remote object removal and overdue backups',async t=>{
 const {directory,key,filename}=await localFixture(t);
 const s3=fakeAws();
 await assert.rejects(()=>offsite.verifyOffsiteHealth({directory,cfg,aws:s3.aws}),/ENOENT/);
 await offsite.publishBackup({filename,outputDir:directory,key,cfg,aws:s3.aws});
 const past=new Date(Date.now()+50*3600000);
 await assert.rejects(()=>offsite.verifyOffsiteHealth({directory,cfg,aws:s3.aws,maxAgeHours:26,now:past}),/stale/);
 s3.setRemote(null);
 await assert.rejects(()=>offsite.verifyOffsiteHealth({directory,cfg,aws:s3.aws}),/Missing remote/);
});
test('remote retention, encryption and checksum must be independently proven',()=>{
 const digest='a'.repeat(64);
 const until=new Date(Date.now()+90*86400000).toISOString();
 const common={cfg,key:'classicfin/a.cfhb',sha256:digest,size:100,versionId:'v1',minimumRetainUntil:Date.now()+30*86400000};
 const remote={VersionId:'v1',ContentLength:100,ChecksumSHA256:Buffer.from(digest,'hex').toString('base64'),ObjectLockMode:'COMPLIANCE',ObjectLockRetainUntilDate:until,ServerSideEncryption:'AES256'};
 assert.doesNotThrow(()=>offsite.checkRemote(remote,common));
 for(const change of [{ObjectLockMode:'GOVERNANCE'},{VersionId:'v0'},{ContentLength:99},{ObjectLockRetainUntilDate:new Date().toISOString()},{ServerSideEncryption:undefined}]){
  assert.throws(()=>offsite.checkRemote({...remote,...change},common));
 }
});
test('disaster recovery fetches an exact retained version and authenticates encrypted bytes before publishing',async t=>{
 const {directory,key,filename}=await localFixture(t);
 const recovery=path.join(directory,'recovery');await fsp.mkdir(recovery,{mode:0o700});
 const s3=fakeAws();
 await offsite.publishBackup({filename,outputDir:directory,key,cfg,aws:s3.aws});
 const aws=async args=>{
  if(args[1]==='get-object'){
    await fsp.copyFile(filename,args[args.length-1]);
    return {VersionId:'version-1'};
  }
  return s3.aws(args);
 };
 const result=await offsite.fetchRetainedBackup({objectKey:`${cfg.prefix}${path.basename(filename)}`,versionId:'version-1',outputDir:recovery,key,cfg,aws});
 assert.equal(result.sha256Verified,true);
 assert.deepEqual(await fsp.readFile(path.join(recovery,path.basename(filename))),await fsp.readFile(filename));
 await assert.rejects(()=>offsite.fetchRetainedBackup({objectKey:`${cfg.prefix}${path.basename(filename)}`,versionId:'version-1',outputDir:recovery,key,cfg,aws}),/Refusing to overwrite/);
});
test('corrupt downloaded remote ciphertext never publishes a local recovery file',async t=>{
 const {directory,key,filename}=await localFixture(t);
 const recovery=path.join(directory,'recovery');await fsp.mkdir(recovery,{mode:0o700});
 const s3=fakeAws();
 await offsite.publishBackup({filename,outputDir:directory,key,cfg,aws:s3.aws});
 const aws=async args=>{
  if(args[1]==='get-object'){
    const content=await fsp.readFile(filename);content[40]^=1;
    await fsp.writeFile(args[args.length-1],content);
    return {VersionId:'version-1'};
  }
  return s3.aws(args);
 };
 await assert.rejects(()=>offsite.fetchRetainedBackup({objectKey:`${cfg.prefix}${path.basename(filename)}`,versionId:'version-1',outputDir:recovery,key,cfg,aws}),/SHA-256 mismatch/);
 assert.deepEqual(await fsp.readdir(recovery),[]);
});
