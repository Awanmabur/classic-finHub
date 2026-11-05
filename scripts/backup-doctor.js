#!/usr/bin/env node
'use strict';
const {loadEncryptionKey}=require('../src/platform/services/backup.service');
const {checkBackupHealth}=require('../src/platform/services/backup-health.service');
async function main(){
 const key=await loadEncryptionKey(process.env.BACKUP_KEY_FILE);
 const report=await checkBackupHealth({directory:process.env.BACKUP_OUTPUT_DIR,key,maxAgeHours:Number(process.env.BACKUP_MAX_AGE_HOURS||26)});
 console.log(JSON.stringify({event:'backup.health',status:'healthy',...report}));
}
main().catch(error=>{console.error(JSON.stringify({event:'backup.health',status:'unhealthy',reason:error.message.replace(/mongodb(?:\+srv)?:\/\/\S+/g,'[redacted-uri]')}));process.exitCode=2;});
