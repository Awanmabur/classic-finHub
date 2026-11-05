'use strict';
// Scheduled by the host's dedicated systemd timer, never by a web request.
// Source URI must cover the entire replica set; tenant databases are included.
const {createBackup, loadEncryptionKey} = require('../platform/services/backup.service');
async function run() {
  const key = await loadEncryptionKey(process.env.BACKUP_KEY_FILE);
  return createBackup({sourceUri:process.env.BACKUP_SOURCE_URI,outputDir:process.env.BACKUP_OUTPUT_DIR,key});
}
module.exports = {run};
