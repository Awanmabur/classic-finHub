#!/usr/bin/env node
'use strict';
// ClassicFin Hub v1.23: generate ALL local-only secrets, retain EVERY template key,
// preserve existing valid credentials, never overwrite the existing .env or print secrets.
// Run from the project root with classicfin-full.env.example beside this script.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cwd = process.cwd();
const templatePath = path.join(__dirname, 'classicfin-full.env.example');
const currentPath = path.join(cwd, '.env');
const currentExists = fs.existsSync(currentPath);
const outputPath = path.join(cwd, currentExists ? '.env.generated' : '.env');
const GENERATED = new Map([
  ['SESSION_SECRET', 48],
  ['JWT_ACCESS_SECRET', 48],
  ['JWT_REFRESH_SECRET', 48],
  ['COOKIE_SECRET', 48],
  ['MFA_ENCRYPTION_KEY', 32],
  ['FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX', 32],
  ['FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX', 32],
]);
const BLOCKED_OVERRIDES = new Set([
  'NODE_ENV', 'APP_URL', 'TRUST_PROXY', 'SEO_INDEXING_ENABLED', 'REAL_MONEY_ENABLED'
]);
const placeholders = /^(?:change(?:[-_ ]?me)?(?:[-_].*)?|replace(?:[-_ ]?me)?(?:[-_].*)?|your[-_].*|example(?:[-_].*)?|<.*>|\.{3})$/i;
const values = new Map();
const previousGenerated = new Map();
try {
  if (!fs.existsSync(templatePath)) throw new Error('Missing classicfin-full.env.example next to this script.');
  if (fs.existsSync(outputPath)) throw new Error(`${path.basename(outputPath)} exists; refusing to overwrite it.`);
  if (currentExists) {
    for (const line of fs.readFileSync(currentPath, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1];
      const raw = match[2].trim();
      if (GENERATED.has(key) && raw && !placeholders.test(raw.replace(/^(['"])(.*)\1$/, '$2'))) {
        previousGenerated.set(key, raw.replace(/^(['"])(.*)\1$/, '$2'));
      }
      // In a duplicated old .env, the last entry is what dotenv actually reads.
      values.set(key, raw);
    }
    const prevMode = (values.get('NODE_ENV') || '').replace(/^['"]|['"]$/g, '');
    if (prevMode === 'production') {
      throw new Error('Existing .env is production. Refusing to merge production credentials into a local development file.');
    }
  }
  const seen = new Set();
  const generatedValues = new Map();
  const comments = fs.readFileSync(templatePath, 'utf8').split(/\r?\n/);
  const result = comments.map(line => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) return line;
    const key = match[1];
    if (seen.has(key)) throw new Error(`Duplicate template key: ${key}`);
    seen.add(key);
    if (GENERATED.has(key)) {
      const saved = previousGenerated.get(key);
      if (saved && (saved.length < 32 || (GENERATED.get(key) === 32 && !/^[a-f0-9]{64}$/i.test(saved)))) {
        throw new Error(`Existing ${key} has an unexpected format; it will NOT be silently rotated.`);
      }
      const selected = saved || crypto.randomBytes(GENERATED.get(key)).toString('hex');
      generatedValues.set(key, selected);
      return `${key}=${selected}`;
    }
    if (BLOCKED_OVERRIDES.has(key)) return line; // always safe local defaults
    let old = values.get(key);
    if (old !== undefined && old !== '' && !placeholders.test(old)) {
      // Only normalize the known old local default, never a custom remote URI.
      if (key === 'MONGO_PLATFORM_URI' && old === 'mongodb://127.0.0.1:27017/classicfin_platform_db') return line;
      return `${key}=${old}`;
    }
    return line;
  });
  for (const [a, b] of [
    ['FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX', 'FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX'],
    ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'],
  ]) {
    if (generatedValues.get(a) === generatedValues.get(b)) throw new Error(`Existing ${a} and ${b} are identical; refusing an unsafe merge.`);
  }
  if (seen.size < 75) throw new Error('Unexpectedly incomplete env template.');
  const file = fs.openSync(outputPath, 'wx', 0o600);
  try { fs.writeFileSync(file, result.join('\n').replace(/\n*$/, '\n'), 'utf8'); }
  finally { fs.closeSync(file); }
  console.log(`Created ${path.basename(outputPath)} with ${seen.size} unique keys and ${GENERATED.size} secure generated secrets.`);
  console.log('No secret values were printed. All provider-issued keys remain blank unless supplied in an existing .env.');
  if (currentExists) console.log('Existing .env was not changed. Review .env.generated, then replace .env when ready.');
  console.log('JWT_* and COOKIE_SECRET are generated for your requested inventory but not used by ClassicFin v1.23.');
} catch (error) {
  console.error(`Environment generation failed: ${error.message}`);
  process.exitCode = 1;
}
