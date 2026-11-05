'use strict';
const fsp=require('node:fs/promises');
const path=require('node:path');
const {verifyBackup}=require('./backup.service');
async function checkBackupHealth({directory,key,maxAgeHours=26,now=new Date()}={}){
 if(!directory || !path.isAbsolute(directory))throw new Error('BACKUP_OUTPUT_DIR must be absolute');
 if(!Number.isFinite(maxAgeHours)||maxAgeHours<1||maxAgeHours>168)throw new Error('Backup freshness threshold must be 1–168 hours');
 const entries=await fsp.readdir(directory,{withFileTypes:true});
 const candidates=[];
 for(const entry of entries){
  if(!entry.isFile()||!/^classicfin-full-.*\.cfhb$/.test(entry.name))continue;
  const filename=path.join(directory,entry.name);
  const stat=await fsp.lstat(filename);
  if(!stat.isFile()||stat.isSymbolicLink())continue;
  candidates.push({filename,mtimeMs:stat.mtimeMs});
 }
 candidates.sort((a,b)=>b.mtimeMs-a.mtimeMs);
 if(!candidates.length)throw new Error('No full encrypted backup archive found');
 const latest=candidates[0];
 if(latest.mtimeMs>now.valueOf()+60000)throw new Error('Backup timestamp is in the future');
 const ageHours=(now.valueOf()-latest.mtimeMs)/3600000;
 if(ageHours>maxAgeHours)throw new Error('Newest encrypted backup exceeds maximum permitted age');
 const integrity=await verifyBackup({filename:latest.filename,key});
 return {backupAgeHours:Number(ageHours.toFixed(2)),backupCount:candidates.length,authenticated:integrity.authenticated,encrypted:integrity.encrypted};
}
module.exports={checkBackupHealth};
