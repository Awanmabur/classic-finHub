#!/usr/bin/env node
'use strict';
const {loadEncryptionKey}=require('../src/platform/services/backup.service');
const {safeConfig,publishBackup,verifyOffsiteHealth,latestArchive,fetchRetainedBackup}=require('../src/platform/services/offsite-backup.service');
function cfg(){return safeConfig({bucket:process.env.OFFSITE_S3_BUCKET,prefix:process.env.OFFSITE_S3_PREFIX||'classicfin/',expectedOwner:process.env.OFFSITE_S3_EXPECTED_OWNER,retentionDays:Number(process.env.OFFSITE_RETENTION_DAYS||90),region:process.env.AWS_REGION});}
async function main(){
  const [action,objectKey,versionId,extra]=process.argv.slice(2);
  if(extra||!['upload-latest','doctor','fetch'].includes(action)||(action!=='fetch'&&(objectKey||versionId))||(action==='fetch'&&(!objectKey||!versionId)))throw new Error('Use: npm run offsite:upload | npm run offsite:doctor | npm run offsite:fetch -- <object-key> <version-id>');
  const directory=process.env.BACKUP_OUTPUT_DIR;
  const config=cfg();
  let result;
  if(action==='upload-latest')result=await publishBackup({filename:await latestArchive(directory),outputDir:directory,key:await loadEncryptionKey(process.env.BACKUP_KEY_FILE),cfg:config});
  else if(action==='doctor')result=await verifyOffsiteHealth({directory,cfg:config,maxAgeHours:Number(process.env.OFFSITE_MAX_AGE_HOURS||26)});
  else result=await fetchRetainedBackup({objectKey,versionId,outputDir:process.env.BACKUP_RECOVERY_DIR,key:await loadEncryptionKey(process.env.BACKUP_KEY_FILE),cfg:config});
  console.log(JSON.stringify({event:'offsite.backup',action,status:'passed',...result}));
}
main().catch(error=>{console.error(JSON.stringify({event:'offsite.backup',status:'failed',reason:error.message.replace(/https?:\/\/\S+/g,'[redacted-url]')}));process.exitCode=2;});
