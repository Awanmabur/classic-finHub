'use strict';
// AWS S3 Object Lock (COMPLIANCE) only. Fail closed on unsupported stores and
// incomplete evidence. A single PutObject supports archives up to 5 GB.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {verifyBackup} = require('./backup.service');

const MAX_OBJECT_BYTES = 5_000_000_000;
const NAME = /^classicfin-full-[A-Za-z0-9-]+\.cfhb$/;
const SHA = /^[a-f0-9]{64}$/;
const BUCKET = /^(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const PREFIX = /^(?:[a-zA-Z0-9_/-]{1,128}\/)?$/;

function safeConfig({bucket, prefix='classicfin/', expectedOwner, retentionDays=90, region}={}) {
  if (!BUCKET.test(bucket||'') || bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(bucket||'')) throw new Error('OFFSITE_S3_BUCKET must be an AWS S3 bucket name');
  if (!PREFIX.test(prefix) || prefix.includes('//') || prefix.includes('..')) throw new Error('OFFSITE_S3_PREFIX must be a simple folder prefix ending in /');
  if (!/^\d{12}$/.test(expectedOwner||'')) throw new Error('OFFSITE_S3_EXPECTED_OWNER must be the 12-digit AWS account ID');
  if (!Number.isInteger(Number(retentionDays)) || Number(retentionDays)<30 || Number(retentionDays)>3650) throw new Error('OFFSITE_RETENTION_DAYS must be 30–3650');
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region||'')) throw new Error('AWS_REGION must be explicitly configured');
  return {bucket,prefix,expectedOwner,retentionDays:Number(retentionDays),region};
}
function safeArchiveName(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || !NAME.test(path.basename(filename))) throw new Error('Require an absolute named ClassicFin full .cfhb archive');
  return path.basename(filename);
}
async function inspectLocal(filename) {
  safeArchiveName(filename);
  const st=await fsp.lstat(filename);
  if (!st.isFile()||st.isSymbolicLink()||st.size<50||st.size>MAX_OBJECT_BYTES) throw new Error('Encrypted backup must be a regular nonempty archive no larger than 5 GB (use provider-native multipart for larger backups)');
  if (process.platform!=='win32' && (st.mode & 0o077)!==0) throw new Error('Encrypted backup must be owner-only (0600)');
  return {size:st.size,mtimeMs:st.mtimeMs};
}
async function sha256File(filename) {
  const h=crypto.createHash('sha256');
  for await(const chunk of fs.createReadStream(filename))h.update(chunk);
  return h.digest('hex');
}
async function runAws(args,{binary='aws',timeoutMs,environment=process.env}={}) {
  if (!Array.isArray(args)||args.some(x=>typeof x!=='string'))throw new Error('Invalid AWS CLI arguments');
  return new Promise((resolve,reject)=>{
    let stdout='';let settled=false;let killed=false;
    const child=spawn(binary,[...args,'--output','json','--no-cli-pager'],{stdio:['ignore','pipe','pipe'],shell:false,env:{...environment,AWS_PAGER:'',AWS_CLI_AUTO_PROMPT:'off'}});
    const deadline=timeoutMs??(['put-object','get-object'].includes(args[1])?7200000:60000);
    const timer=setTimeout(()=>{killed=true;child.kill('SIGKILL');},deadline);
    child.stdout.on('data',buf=>{stdout+=buf.toString('utf8');if(stdout.length>32768){killed=true;child.kill('SIGKILL');}});
    child.stderr.on('data',()=>{}); // Never leak AWS account IDs, endpoint URLs or access credentials.
    const settle=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(err)reject(err);else resolve(result);};
    child.once('error',()=>settle(new Error('AWS CLI could not launch; verify installation and private credentials')));
    child.once('close',code=>{
      if(killed||code!==0)return settle(new Error('AWS S3 operation failed or timed out'));
      try{settle(null,JSON.parse(stdout||'{}'));}catch{settle(new Error('AWS S3 returned invalid JSON'));}
    });
  });
}
// Pin an actual AWS S3 regional HTTPS endpoint; never silently send private
// backup ciphertext to a configured S3-compatible endpoint or proxy.
const ownerArgs = cfg => ['--expected-bucket-owner',cfg.expectedOwner,'--region',cfg.region,'--endpoint-url',`https://s3.${cfg.region}.${cfg.region.startsWith('cn-')?'amazonaws.com.cn':'amazonaws.com'}`];
async function inspectBucket(cfg, aws=runAws) {
  const versioning=await aws(['s3api','get-bucket-versioning','--bucket',cfg.bucket,...ownerArgs(cfg)]);
  if(versioning.Status!=='Enabled')throw new Error('Offsite S3 bucket must have versioning Enabled');
  const settings=await aws(['s3api','get-object-lock-configuration','--bucket',cfg.bucket,...ownerArgs(cfg)]);
  if(settings.ObjectLockConfiguration?.ObjectLockEnabled!=='Enabled')throw new Error('Offsite S3 bucket must have Object Lock Enabled');
  return true;
}
function checkRemote(remote,{cfg,key,sha256,size,minimumRetainUntil,versionId}) {
  if (typeof remote!=='object'||!remote)throw new Error('Missing remote object evidence');
  if(!Number.isFinite(minimumRetainUntil))throw new Error('Retention verification threshold invalid');
  if(remote.VersionId!==versionId || !versionId || versionId==='null')throw new Error('Object version not verified');
  if(remote.ContentLength!==size)throw new Error('Remote backup byte length mismatch');
  if(remote.ChecksumSHA256!==Buffer.from(sha256,'hex').toString('base64'))throw new Error('Remote SHA-256 checksum mismatch');
  if(remote.ObjectLockMode!=='COMPLIANCE')throw new Error('Remote Object Lock COMPLIANCE retention missing');
  if(!remote.ObjectLockRetainUntilDate || Date.parse(remote.ObjectLockRetainUntilDate)<minimumRetainUntil)throw new Error('Remote Object Lock retention insufficient');
  if(remote.ServerSideEncryption!=='AES256' && remote.ServerSideEncryption!=='aws:kms')throw new Error('Remote encryption at rest not confirmed');
  if(typeof key!=='string'||!key.startsWith(cfg.prefix)||!key.endsWith('.cfhb'))throw new Error('Invalid remote archive key');
  return true;
}
async function readReceipt(filename) {
  const st=await fsp.lstat(filename);
  if(!st.isFile()||st.isSymbolicLink()||(process.platform!=='win32' && (st.mode&0o077)))throw new Error('Offsite receipt permissions invalid');
  const obj=JSON.parse(await fsp.readFile(filename,'utf8'));
  if(obj.schema!==1||!Number.isFinite(Date.parse(obj.uploadedAt))||!Number.isFinite(Date.parse(obj.minRetainUntil))||typeof obj.key!=='string'||!SHA.test(obj.sha256||'')||!Number.isFinite(obj.size)||typeof obj.versionId!=='string'||!obj.versionId||obj.versionId.length>2048||/[\x00-\x1f\x7f]/.test(obj.versionId))throw new Error('Offsite receipt invalid');
  return obj;
}
async function writeReceipt(filename,receipt) {
  const temp=`${filename}.${crypto.randomUUID()}.partial`;
  try{
    await fsp.writeFile(temp,`${JSON.stringify(receipt)}\n`,{mode:0o600,flag:'wx'});
    // Fail rather than replace an independently verified prior receipt.
    await fsp.link(temp,filename);
  } finally {await fsp.rm(temp,{force:true});}
}
async function headObject({cfg,key,versionId,aws=runAws}){
  return aws(['s3api','head-object','--bucket',cfg.bucket,'--key',key,'--version-id',versionId,'--checksum-mode','ENABLED',...ownerArgs(cfg)]);
}
async function publishBackup({filename,outputDir,key,cfg,aws=runAws,now=new Date()}={}) {
  cfg=safeConfig(cfg);
  const base=safeArchiveName(filename);
  if(!outputDir||!path.isAbsolute(outputDir)||path.resolve(path.dirname(filename))!==path.resolve(outputDir))throw new Error('Offsite archive must belong directly to configured backup directory');
  const stat=await inspectLocal(filename);
  if(!Buffer.isBuffer(key)||key.length!==32)throw new Error('Backup verification key required for offsite upload');
  await verifyBackup({filename,key}); // Never replicate a corrupted locally encrypted archive.
  const digest=await sha256File(filename);
  await inspectBucket(cfg,aws);
  const receiptsDir=path.join(outputDir,'receipts');
  await fsp.mkdir(receiptsDir,{mode:0o700,recursive:true});
  const rst=await fsp.lstat(receiptsDir);
  if(!rst.isDirectory()||rst.isSymbolicLink()||(process.platform!=='win32'&&(rst.mode&0o077)))throw new Error('Receipt directory must be private and non-symlink');
  const receiptFile=path.join(receiptsDir,`${base}.json`);
  const objectKey=`${cfg.prefix}${base}`;
  let receipt;
  try{receipt=await readReceipt(receiptFile);}catch(err){if(err.code!=='ENOENT')throw err;}
  if(receipt) {
    if(receipt.bucket!==cfg.bucket||receipt.key!==objectKey||receipt.sha256!==digest||receipt.size!==stat.size)throw new Error('Offsite receipt does not match local archive');
    const remote=await headObject({cfg,key:objectKey,versionId:receipt.versionId,aws});
    checkRemote(remote,{cfg,key:objectKey,sha256:digest,size:stat.size,minimumRetainUntil:Date.parse(receipt.minRetainUntil),versionId:receipt.versionId});
    return {status:'verified-existing',archive:base,versionVerified:true,complianceRetention:true};
  }
  const until=new Date(now.valueOf()+cfg.retentionDays*86400000).toISOString();
  if(!Number.isFinite(Date.parse(until)))throw new Error('Invalid retention timestamp');
  // Single PUT guarantees the stored checksum matches the entire encrypted archive.
  // For >5 GB, fail closed instead of claiming multipart integrity we cannot prove.
  const response=await aws(['s3api','put-object','--bucket',cfg.bucket,'--key',objectKey,'--body',filename,
    '--checksum-sha256',Buffer.from(digest,'hex').toString('base64'),
    '--object-lock-mode','COMPLIANCE','--object-lock-retain-until-date',until,'--server-side-encryption','AES256',...ownerArgs(cfg)]);
  if(typeof response.VersionId!=='string'||response.VersionId==='null'||!response.VersionId)throw new Error('S3 did not confirm a retained object version');
  const remote=await headObject({cfg,key:objectKey,versionId:response.VersionId,aws});
  checkRemote(remote,{cfg,key:objectKey,sha256:digest,size:stat.size,minimumRetainUntil:Date.parse(until),versionId:response.VersionId});
  const after=await inspectLocal(filename);
  if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw new Error('Backup changed during offsite upload; receipt withheld');
  receipt={schema:1,bucket:cfg.bucket,key:objectKey,versionId:response.VersionId,sha256:digest,size:stat.size,minRetainUntil:until,uploadedAt:now.toISOString()};
  await writeReceipt(receiptFile,receipt);
  return {status:'uploaded-and-verified',archive:base,versionVerified:true,complianceRetention:true};
}
async function verifyOffsiteHealth({directory,cfg,aws=runAws,maxAgeHours=26,now=new Date()}={}) {
  cfg=safeConfig(cfg);
  if(!directory||!path.isAbsolute(directory)||!Number.isFinite(maxAgeHours)||maxAgeHours<1||maxAgeHours>168)throw new Error('Offsite health configuration invalid');
  const receiptsDir=path.join(directory,'receipts');
  const list=(await fsp.readdir(receiptsDir,{withFileTypes:true})).filter(x=>x.isFile()&&NAME.test(x.name.replace(/\.json$/,''))&&x.name.endsWith('.json'));
  if(!list.length)throw new Error('No independently verified offsite backup receipts');
  const receipts=[];
  for(const entry of list){const receipt=await readReceipt(path.join(receiptsDir,entry.name));if(receipt.bucket===cfg.bucket&&receipt.key.startsWith(cfg.prefix))receipts.push(receipt);}
  if(!receipts.length)throw new Error('No offsite receipts for configured bucket');
  receipts.sort((a,b)=>Date.parse(b.uploadedAt)-Date.parse(a.uploadedAt));
  const latest=receipts[0];
  const ageHours=(now.valueOf()-Date.parse(latest.uploadedAt))/3600000;
  if(!Number.isFinite(ageHours)||ageHours< -0.017||ageHours>maxAgeHours)throw new Error('Offsite backup is stale or has invalid timestamp');
  const remote=await headObject({cfg,key:latest.key,versionId:latest.versionId,aws});
  checkRemote(remote,{cfg,key:latest.key,sha256:latest.sha256,size:latest.size,minimumRetainUntil:Date.parse(latest.minRetainUntil),versionId:latest.versionId});
  if(Date.parse(remote.ObjectLockRetainUntilDate)<=now.valueOf())throw new Error('Offsite retention has already expired');
  return {status:'healthy',offsiteAgeHours:Number(ageHours.toFixed(2)),complianceRetention:true,checksumVerified:true,remoteVersionVerified:true,receiptCount:receipts.length};
}
// Restore ciphertext from an independently retained object version, then
// authenticate the downloaded archive before allowing a rehearsal. Supports
// disaster recovery even when all local receipt files were lost.
async function fetchRetainedBackup({objectKey,versionId,outputDir,key,cfg,aws=runAws,now=new Date()}={}){
 cfg=safeConfig(cfg);
 if(typeof objectKey!=='string'||!objectKey.startsWith(cfg.prefix)||!NAME.test(objectKey.slice(cfg.prefix.length)))throw new Error('Offsite key must be a named full backup under the configured prefix');
 if(typeof versionId!=='string'||versionId.length>2048||!/^[A-Za-z0-9+/=._~-]+$/.test(versionId))throw new Error('Explicit immutable S3 version ID required');
 if(!outputDir||!path.isAbsolute(outputDir))throw new Error('Restore output directory must be absolute');
 const st=await fsp.lstat(outputDir);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))throw new Error('Restore output directory must be private (0700)');
 if(!Buffer.isBuffer(key)||key.length!==32)throw new Error('Backup decryption key required');
 const remote=await headObject({cfg,key:objectKey,versionId,aws});
 if(typeof remote.ChecksumSHA256!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(remote.ChecksumSHA256))throw new Error('Missing remote checksum');
 const sha=Buffer.from(remote.ChecksumSHA256,'base64');
 if(sha.length!==32)throw new Error('Invalid remote SHA-256 checksum');
 const checksum=sha.toString('hex');
 if(!Number.isSafeInteger(remote.ContentLength)||remote.ContentLength>MAX_OBJECT_BYTES||remote.ContentLength<50)throw new Error('Remote archive exceeds safe download bounds');
 checkRemote(remote,{cfg,key:objectKey,sha256:checksum,size:remote.ContentLength,minimumRetainUntil:now.valueOf(),versionId});
 const filename=path.join(outputDir,objectKey.slice(cfg.prefix.length));
 try{await fsp.lstat(filename);throw new Error('Refusing to overwrite existing local backup');}catch(error){if(error.code!=='ENOENT')throw error;}
 const temp=path.join(outputDir,`.${path.basename(filename)}.${crypto.randomUUID()}.partial`);
 try{
  await fsp.writeFile(temp,'',{flag:'wx',mode:0o600});
  const meta=await aws(['s3api','get-object','--bucket',cfg.bucket,'--key',objectKey,'--version-id',versionId,...ownerArgs(cfg),temp]);
  if(meta.VersionId!==versionId)throw new Error('Downloaded S3 object version does not match requested version');
  // inspectLocal intentionally accepts only final archive names; check staged file here.
  const staged=await fsp.lstat(temp);
  if(!staged.isFile()||staged.isSymbolicLink()||staged.size!==remote.ContentLength)throw new Error('Downloaded archive size mismatch');
  if(process.platform!=='win32'&&(staged.mode&0o077))throw new Error('Downloaded archive permissions must be 0600');
  if(await sha256File(temp)!==checksum)throw new Error('Downloaded encrypted archive SHA-256 mismatch');
  await verifyBackup({filename:temp,key});
  await fsp.link(temp,filename);
  return {status:'downloaded-and-authenticated',archive:path.basename(filename),versionVerified:true,sha256Verified:true};
 }finally{await fsp.rm(temp,{force:true});}
}
async function latestArchive(directory){
  if(!directory||!path.isAbsolute(directory))throw new Error('BACKUP_OUTPUT_DIR must be absolute');
  const names=(await fsp.readdir(directory,{withFileTypes:true})).filter(x=>x.isFile()&&NAME.test(x.name));
  if(!names.length)throw new Error('No encrypted full backup to replicate');
  const stats=await Promise.all(names.map(async x=>({name:x.name,st:await fsp.lstat(path.join(directory,x.name))})));
  stats.sort((a,b)=>b.st.mtimeMs-a.st.mtimeMs);
  return path.join(directory,stats[0].name);
}
module.exports={safeConfig,safeArchiveName,inspectLocal,sha256File,runAws,inspectBucket,checkRemote,publishBackup,verifyOffsiteHealth,latestArchive,fetchRetainedBackup,MAX_OBJECT_BYTES};
