#!/usr/bin/env node
'use strict';
// Verify or explicitly export a business archive. No database writes or restore.
require('dotenv').config();
const fs=require('node:fs/promises'),path=require('node:path');
async function main(){const args=process.argv.slice(2),command=args.shift();if(!['verify','export-json'].includes(command))throw Error('Use verify or export-json with --file, optional expected --tenant/--scope and --output for export');const values={};while(args.length){const name=args.shift(),value=args.shift();if(!['--file','--tenant','--scope','--output'].includes(name)||!value||values[name])throw Error('Invalid archive arguments');values[name]=value;}
 const file=path.resolve(values['--file']||''),match=/^[a-f0-9]{24}-([a-f0-9]{64})\.cfhbackup$/.exec(path.basename(file));if(!match)throw Error('Invalid archive filename');const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>27*1024*1024)throw Error('Invalid archive file');
 const body=await fs.readFile(file),service=require('../src/tenant/backups/service'),metadata=service.archiveMetadata(body);
 const tenantId=values['--tenant']||metadata?.tenantId,scope=values['--scope']||metadata?.scopeKey;
 if(!/^[a-f0-9]{24}$/i.test(tenantId||'')||!/^(?:tenant|branch_[a-f0-9]{24})$/.test(scope||''))throw Error('Older archives require explicit tenant and scope');
 const input={TENANT_BACKUPS_ENABLED:'true',TENANT_BACKUP_ENCRYPTION_KEY:process.env.TENANT_BACKUP_ENCRYPTION_KEY,TENANT_BACKUP_DIR:path.dirname(file)};
 const value=service.verify(body,{_id:tenantId},{scopeKey:scope},match[1],input);
 if(command==='export-json'){if(!values['--output'])throw Error('Explicit private --output path required');const target=path.resolve(values['--output']),parent=await fs.lstat(path.dirname(target));if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)!==0)throw Error('Output directory must be private (0700)');await fs.writeFile(target,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
 console.log(JSON.stringify({verified:true,format:value.manifest.format,scope:value.manifest.scopeKey,recordCount:value.manifest.recordCount,digest:match[1],exported:command==='export-json'}));
}
main().catch(()=>{console.error('Archive verification/export failed. Check the private key, tenant/scope, filename and private output directory. No database was modified.');process.exitCode=1;});
