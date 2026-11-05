#!/usr/bin/env node
'use strict';
// Run locally in your ClassicFin Hub v1.23 repository; no third-party modules.
// Never sends, prints, or exports secret values.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cwd = process.cwd();
const existingPath = path.join(cwd, '.env');
const hasExisting = fs.existsSync(existingPath);
const target = path.join(cwd, hasExisting ? '.env.review' : '.env');
if (fs.existsSync(target)) {
  console.error(`${path.basename(target)} already exists; refusing to overwrite it.`);
  process.exit(1);
}
const current = {};
if (hasExisting) {
  for (const line of fs.readFileSync(existingPath, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match) current[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}
const key64 = () => crypto.randomBytes(32).toString('hex');
const validHex = (v) => /^[a-f\d]{64}$/i.test(v || '');
const session = (current.SESSION_SECRET && current.SESSION_SECRET.length >= 32 && !/change.?me|replace.?me/i.test(current.SESSION_SECRET))
  ? current.SESSION_SECRET : crypto.randomBytes(48).toString('hex');
const mfa = validHex(current.MFA_ENCRYPTION_KEY) ? current.MFA_ENCRYPTION_KEY : key64();
const callback = validHex(current.FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX) ? current.FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX : key64();
let statement = validHex(current.FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX) ? current.FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX : key64();
if (callback.toLowerCase() === statement.toLowerCase()) statement = key64();
const lines = [
  '# ClassicFin Hub v1.23 — private DEVELOPMENT configuration. Do not commit.',
  'NODE_ENV=development',
  'PORT=3000',
  'APP_URL=http://localhost:3000',
  'TRUST_PROXY=0',
  'SEO_INDEXING_ENABLED=false',
  'REAL_MONEY_ENABLED=false',
  '',
  `SESSION_SECRET=${session}`,
  `MFA_ENCRYPTION_KEY=${mfa}`,
  `FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX=${callback}`,
  `FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX=${statement}`,
  '',
  '# Development replica set: port 27018, not standalone MongoDB on 27017.',
  'MONGO_PLATFORM_URI=mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true',
  'MONGO_POOL_MAX=30',
  '',
  `RESEND_API_KEY=${current.RESEND_API_KEY || ''}`,
  `MAIL_FROM=${current.MAIL_FROM || ''}`,
  'OUTBOX_POLL_MS=2000',
  'NOTIFICATION_POLL_MS=5000',
  '',
  '# Worker DB users, production Mongo, backups, S3 and alerts go in separate env files.',
  '# SMS and live payments are disabled in v1.23; obsolete mock/provider keys omitted.',
];
fs.writeFileSync(target, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Created ${path.basename(target)} with four secure secrets. Secret values were not printed.`);
if (hasExisting) {
  console.log('Existing .env was NOT modified. Compare .env.review privately before replacing it.');
  console.log('Preserved existing valid SESSION_SECRET and MFA_ENCRYPTION_KEY when found.');
  console.log('Other old provider and database settings were NOT migrated automatically.');
} else {
  console.log('Configure optional Resend credentials later; MongoDB local URL is already set.');
}
