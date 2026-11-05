'use strict';
// Local Windows / Linux development with an isolated Mongo replica set and
// persisted development-only MFA encryption key, never checked into Git.
const { run } = require('./db-local');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
try {
  if (process.env.NODE_ENV === 'production') throw new Error('dev:local is for development only');
  const keyFile = path.resolve(__dirname,'../.classicfin-dev-mfa.key');
  let mfaKey = process.env.MFA_ENCRYPTION_KEY;
  if (!mfaKey) {
    try {
      fs.writeFileSync(keyFile,crypto.randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
      console.log('Created a persistent, Git-ignored development MFA key. Keep it private.');
    } catch(e){ if(e.code!=='EEXIST')throw e; }
    if (fs.lstatSync(keyFile).isSymbolicLink()) throw new Error('Refusing symlink for development MFA key');
    mfaKey=fs.readFileSync(keyFile,'utf8').trim();
  }
  if (!/^[a-f0-9]{64}$/i.test(mfaKey)) throw new Error('Invalid development MFA encryption key');
  run('up');
  const localUri = 'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true';
  const result = spawnSync(process.execPath, ['--watch', 'src/server.js'], {
    env: { ...process.env, NODE_ENV:'development', MONGO_PLATFORM_URI:localUri, MFA_ENCRYPTION_KEY:mfaKey },
    stdio:'inherit', windowsHide:false
  });
  process.exitCode = result.status === null ? 1 : result.status;
} catch(e) { console.error('Local startup failed:', e.message); process.exitCode = 1; }
