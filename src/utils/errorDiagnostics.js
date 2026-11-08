'use strict';
// Deliberately omit exception messages, queries, bodies and dependency stacks:
// they can contain database credentials, tokens or customer data.
const path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'..').replace(/\\/g,'/');
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const frame=new RegExp(escape(root)+'/([A-Za-z0-9_./-]+\\.(?:js|ejs)):(\\d{1,7})(?::\\d+)?');
const names=new Set(['Error','TypeError','ReferenceError','RangeError','SyntaxError','ValidationError','CastError','MongoServerError','MongoNetworkError','MongoServerSelectionError','MongooseServerSelectionError']);
const codes=new Set(['MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND','ENOENT','ENOSPC','EACCES','EPERM','EROFS','ETIMEDOUT','ECONNREFUSED','ENOTFOUND','MFA_KEY_MISSING','MFA_SECRET_UNAVAILABLE','MFA_KEY_FILE_UNSAFE','MFA_KEY_FILE_INVALID','MFA_KEY_FILE_UNREADABLE','BACKUP_DISABLED','BACKUP_KEY_MISSING','BACKUP_KEY_WEAK','BACKUP_KEY_MUST_BE_DISTINCT','BACKUP_DIRECTORY_MISSING','BACKUP_DIRECTORY_NOT_PRIVATE','BACKUP_ORIGIN_INVALID','BACKUP_GOOGLE_CONFIGURATION_INVALID','BACKUP_GOOGLE_NOT_CONFIGURED','BACKUP_ARCHIVE_UNAVAILABLE','BACKUP_STORAGE_UNAVAILABLE','BACKUP_VERIFICATION_FAILED']);
const messages={
 MFA_KEY_MISSING:'Sign-in verification is not configured. The administrator must configure the authenticator encryption key.',
 MFA_SECRET_UNAVAILABLE:'Sign-in verification cannot unlock this account. The administrator must restore the original authenticator encryption key.',
 BACKUP_ARCHIVE_UNAVAILABLE:'This backup file is unavailable in the current storage. Ask the administrator to check the backup volume or recover a saved copy.',
 BACKUP_STORAGE_UNAVAILABLE:'Backup storage is unavailable. Ask the administrator to check the backup volume and its permissions.',
 BACKUP_VERIFICATION_FAILED:'This backup could not be verified. No file was downloaded. Ask the administrator to check the backup key and recover a verified copy.'
};
for(const code of ['BACKUP_DISABLED','BACKUP_KEY_MISSING','BACKUP_KEY_WEAK','BACKUP_KEY_MUST_BE_DISTINCT','BACKUP_DIRECTORY_MISSING','BACKUP_DIRECTORY_NOT_PRIVATE','BACKUP_ORIGIN_INVALID','BACKUP_GOOGLE_CONFIGURATION_INVALID','BACKUP_GOOGLE_NOT_CONFIGURED'])messages[code]='Tenant backups are not ready yet. Ask the platform administrator to complete backup setup.';
function knownFile(relative){
 if(relative.split('/').includes('..'))return false;
 try{return fs.lstatSync(path.join(root,relative)).isFile();}catch{return false;}
}
function source(error){
 const lines=typeof error.stack==='string'?error.stack.replace(/\\/g,'/').split('\n').slice(1):[];
 if(typeof error.path==='string')lines.unshift(error.path.replace(/\\/g,'/')+':0');
 for(const line of lines){const match=frame.exec(line);if(match&&knownFile(match[1]))return 'src/'+match[1]+(match[2]!=='0'?':'+match[2]:'');}
 return undefined;
}
function inspect(error){const errorCode=error.code===11000?'DUPLICATE_KEY':codes.has(error.code)?error.code:'APPLICATION_ERROR';return {errorType:names.has(error.name)?error.name:'Error',errorCode,source:source(error),publicMessage:messages[errorCode]};}
module.exports={inspect};
