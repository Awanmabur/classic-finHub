'use strict';
const path=require('node:path');
const failure=(code,status=503)=>Object.assign(new Error('Tenant backup service is unavailable'),{code,status});
function settings(input=process.env){
 const enabled=input.TENANT_BACKUPS_ENABLED==='true';if(!enabled)return {enabled:false,google:false};
 if(!/^[a-f0-9]{64}$/i.test(input.TENANT_BACKUP_ENCRYPTION_KEY||''))throw failure('BACKUP_KEY_MISSING');
 if(input.NODE_ENV==='production'&&/^([a-f0-9])\1{63}$/i.test(input.TENANT_BACKUP_ENCRYPTION_KEY))throw failure('BACKUP_KEY_WEAK');
 if([input.MFA_ENCRYPTION_KEY,input.TRANSFER_SMS_ENCRYPTION_KEY].filter(Boolean).some(key=>String(key).toLowerCase()===input.TENANT_BACKUP_ENCRYPTION_KEY.toLowerCase()))throw failure('BACKUP_KEY_MUST_BE_DISTINCT');
 if(!input.TENANT_BACKUP_DIR||!path.isAbsolute(input.TENANT_BACKUP_DIR))throw failure('BACKUP_DIRECTORY_MISSING');
 const origin=new URL(input.APP_URL||'http://localhost:3000');if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||!['https:','http:'].includes(origin.protocol)||(input.NODE_ENV==='production'&&origin.protocol!=='https:'))throw failure('BACKUP_ORIGIN_INVALID');
 const clientId=input.GOOGLE_DRIVE_CLIENT_ID||'',clientSecret=input.GOOGLE_DRIVE_CLIENT_SECRET||'';
 if(Boolean(clientId)!==Boolean(clientSecret)||clientId&&!/^[a-zA-Z0-9._-]{10,250}\.apps\.googleusercontent\.com$/.test(clientId)||clientSecret&&(!/^[A-Za-z0-9_-]{16,250}$/.test(clientSecret)))throw failure('BACKUP_GOOGLE_CONFIGURATION_INVALID');
 return {enabled:true,google:Boolean(clientId&&clientSecret),key:Buffer.from(input.TENANT_BACKUP_ENCRYPTION_KEY,'hex'),directory:path.resolve(input.TENANT_BACKUP_DIR),clientId,clientSecret,callback:origin.origin+'/tenant/backups/google/callback'};
}
module.exports={settings,failure};
