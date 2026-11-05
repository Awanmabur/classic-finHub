#!/usr/bin/env node
'use strict';
const {loadEncryptionKey, verifyBackup, rehearseBackup} = require('../src/platform/services/backup.service');
const path = require('node:path');
async function main() {
  const [action, filename, extra] = process.argv.slice(2);
  if (extra || !['create','verify','rehearse'].includes(action)) {
    throw new Error('Usage: npm run backup:create | npm run backup:verify -- /absolute/archive.cfhb | npm run backup:rehearse -- /absolute/archive.cfhb');
  }
  const key = action === 'create' ? null : await loadEncryptionKey(process.env.BACKUP_KEY_FILE);
  let result;
  if (action === 'create') {
    result = await require('../src/jobs/backup.job').run();
  } else {
    if (!filename || !path.isAbsolute(filename) || !filename.endsWith('.cfhb')) throw new Error('Provide an absolute .cfhb archive filename');
    result = action === 'verify' ? await verifyBackup({filename, key}) : await rehearseBackup({filename, key, targetUri: process.env.BACKUP_RESTORE_URI});
  }
  console.log(JSON.stringify({operation:`backup.${action}`, status:'passed',...result}));
}
main().catch(error => {
  // Never print raw tool errors or MongoDB connection strings.
  console.error(JSON.stringify({operation:'backup', status:'failed', reason:error.message.replace(/mongodb(?:\+srv)?:\/\/\S+/g,'[redacted-uri]')}));
  process.exitCode = 1;
});
