'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const dotenv = require('dotenv');
const mfa = require('../src/platform/services/mfa.service');
const { loadDevelopmentMfaKey } = require('../src/config/developmentMfaKey');

function developmentLaunch({ explicitKey, dotenvKey, nodeEnv }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfh-dev-mfa-'));
  const keyFile = path.join(directory, '.classicfin-dev-mfa.key');
  const dotenvFile = path.join(directory, '.env');
  const retainedKey = crypto.randomBytes(32).toString('hex');
  const env = explicitKey === undefined ? {} : { MFA_ENCRYPTION_KEY: explicitKey };
  let child, databaseStarts = 0;
  try {
    fs.writeFileSync(keyFile, retainedKey, { mode: 0o600 });
    fs.writeFileSync(dotenvFile, [dotenvKey === undefined ? '' : `MFA_ENCRYPTION_KEY=${dotenvKey}`,
      nodeEnv ? `NODE_ENV=${nodeEnv}` : ''].join('\n'), { mode: 0o600 });
    const launchProcess = { env, execPath: process.execPath };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/dev-local.js'), 'utf8'), {
      __dirname: path.join(directory, 'scripts'), process: launchProcess,
      console: { log() {}, error() {} },
      require(name) {
        if (name === 'dotenv') return { config: () => dotenv.config({ path: dotenvFile, processEnv: env }) };
        if (name === './db-local') return { run: () => { databaseStarts++; } };
        if (name === 'child_process') return { spawnSync(command, args, options) {
          child = { command, args, env: options.env }; return { status: 0 };
        } };
        return require(name);
      }
    });
    assert.equal(fs.readFileSync(keyFile, 'utf8'), retainedKey, 'retained development key must never be overwritten');
    return { child, databaseStarts, exitCode: launchProcess.exitCode, retainedKey };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('dev:local uses the .env MFA key and preserves explicit environment precedence', () => {
  const configuredKey = crypto.randomBytes(32).toString('hex');
  const explicitKey = crypto.randomBytes(32).toString('hex');
  const configured = developmentLaunch({ dotenvKey: configuredKey });
  assert.equal(configured.child.env.MFA_ENCRYPTION_KEY, configuredKey);
  assert.equal(configured.databaseStarts, 1);
  const explicit = developmentLaunch({ explicitKey, dotenvKey: configuredKey });
  assert.equal(explicit.child.env.MFA_ENCRYPTION_KEY, explicitKey);
  const retained = developmentLaunch({});
  assert.equal(retained.child.env.MFA_ENCRYPTION_KEY, retained.retainedKey);
});

test('dev:local reads production and invalid-key configuration before starting a child', () => {
  for (const fixture of [{ nodeEnv: 'production' }, { dotenvKey: 'invalid-configured-key' }]) {
    const result = developmentLaunch(fixture);
    assert.equal(result.exitCode, 1);
    assert.equal(result.child, undefined);
    assert.equal(result.databaseStarts, 0);
  }
});

test('plain development startup reuses a retained MFA key without creating or overwriting files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfh-retained-mfa-'));
  const keyFile = path.join(directory, '.classicfin-dev-mfa.key');
  const key = crypto.randomBytes(32).toString('hex');
  try {
    const missing = { NODE_ENV: 'development' };
    assert.equal(loadDevelopmentMfaKey({ env: missing, keyFile }), false);
    assert.equal(missing.MFA_ENCRYPTION_KEY, undefined);
    assert.equal(fs.existsSync(keyFile), false, 'normal startup must not generate a key');
    fs.writeFileSync(keyFile, key + '\n', { mode: 0o600 });
    for (const env of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'development', MFA_ENCRYPTION_KEY: '' }]) {
      assert.equal(loadDevelopmentMfaKey({ env, keyFile }), true);
      assert.equal(env.MFA_ENCRYPTION_KEY, key);
    }
    const configuredKey = crypto.randomBytes(32).toString('hex');
    const explicit = { NODE_ENV: 'development', MFA_ENCRYPTION_KEY: configuredKey };
    assert.equal(loadDevelopmentMfaKey({ env: explicit, keyFile }), false);
    assert.equal(explicit.MFA_ENCRYPTION_KEY, configuredKey);
    assert.equal(fs.readFileSync(keyFile, 'utf8'), key + '\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('retained-key fallback rejects unsafe files and never runs in production or test', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfh-unsafe-mfa-'));
  const keyFile = path.join(directory, '.classicfin-dev-mfa.key');
  const originalKey = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(keyFile);
    for (const NODE_ENV of ['production', 'test']) {
      const env = { NODE_ENV };
      assert.equal(loadDevelopmentMfaKey({ env, keyFile }), false);
      assert.equal(env.MFA_ENCRYPTION_KEY, undefined);
    }
    assert.throws(() => loadDevelopmentMfaKey({ env: {}, keyFile }), { code: 'MFA_KEY_FILE_UNSAFE' });
    fs.rmdirSync(keyFile);
    fs.writeFileSync(keyFile, 'invalid retained key', { mode: 0o600 });
    assert.throws(() => loadDevelopmentMfaKey({ env: {}, keyFile }), { code: 'MFA_KEY_FILE_INVALID' });
    assert.equal(fs.readFileSync(keyFile, 'utf8'), 'invalid retained key');
    fs.writeFileSync(keyFile, originalKey);
    if (process.platform !== 'win32') {
      fs.chmodSync(keyFile, 0o644);
      assert.throws(() => loadDevelopmentMfaKey({ env: {}, keyFile }), { code: 'MFA_KEY_FILE_UNSAFE' });
      fs.chmodSync(keyFile, 0o600);
      const link = path.join(directory, 'key-symlink');
      fs.symlinkSync(keyFile, link);
      assert.throws(() => loadDevelopmentMfaKey({ env: {}, keyFile: link }), { code: 'MFA_KEY_FILE_UNSAFE' });
    }
    assert.equal(fs.readFileSync(keyFile, 'utf8'), originalKey);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('MFA decrypt classifies missing, mismatched and damaged secrets without disclosing them', t => {
  const previous = process.env.MFA_ENCRYPTION_KEY;
  t.after(() => { if (previous === undefined) delete process.env.MFA_ENCRYPTION_KEY; else process.env.MFA_ENCRYPTION_KEY = previous; });
  const originalKey = crypto.randomBytes(32).toString('hex');
  process.env.MFA_ENCRYPTION_KEY = originalKey;
  const secret = mfa.generateSecret(), encrypted = mfa.encryptSecret(secret);
  assert.equal(mfa.decryptSecret(encrypted), secret);
  delete process.env.MFA_ENCRYPTION_KEY;
  assert.throws(() => mfa.decryptSecret(encrypted), { status: 503, code: 'MFA_KEY_MISSING' });
  process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  assert.throws(() => mfa.decryptSecret(encrypted), { status: 503, code: 'MFA_SECRET_UNAVAILABLE' });
  for (const invalid of [undefined, 'not-an-encrypted-secret', 'a.b.c']) {
    assert.throws(() => mfa.decryptSecret(invalid), { status: 503, code: 'MFA_SECRET_UNAVAILABLE' });
  }
  process.env.MFA_ENCRYPTION_KEY = originalKey;
  assert.equal(mfa.decryptSecret(encrypted), secret, 'the original enrollment must remain usable');
});

test('MFA challenge rejects a wrong or missing key without replacing enrollment or granting a session', async t => {
  const previousPolicy=process.env.MFA_ENABLED;process.env.MFA_ENABLED='true';
  t.after(()=>{if(previousPolicy===undefined)delete process.env.MFA_ENABLED;else process.env.MFA_ENABLED=previousPolicy;});
  const express = require('express');
  const Admin = require('../src/platform/models/PlatformAdmin');
  const Identity = require('../src/platform/models/AccountIdentity');
  const previous = process.env.MFA_ENCRYPTION_KEY;
  t.after(() => { if (previous === undefined) delete process.env.MFA_ENCRYPTION_KEY; else process.env.MFA_ENCRYPTION_KEY = previous; });
  process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  const secret = mfa.generateSecret(), encrypted = mfa.encryptSecret(secret);
  const account = { _id: '507f1f77bcf86cd799439011', email: 'mfa-key-test@example.invalid',
    role: 'Super Admin', status: 'active', authVersion: 0, mfaEnabledAt: new Date(),
    mfaSecretEncrypted: encrypted, mfaLastCounter: -1 };
  let writes = 0, fullSessions = 0;
  t.mock.method(Admin, 'findOne', () => ({ select() { return this; }, lean: async () => ({ ...account }) }));
  t.mock.method(Admin, 'findOneAndUpdate', () => { writes++; throw new Error('Unexpected account update'); });
  t.mock.method(Identity, 'exists', async () => ({ _id: '507f1f77bcf86cd799439012' }));
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { pendingMfa: { platformId: account._id, identityId: '507f1f77bcf86cd799439012',
      authVersion: 0, startedAt: Date.now(), attempts: 0, mode: 'challenge' },
    regenerate() { fullSessions++; throw new Error('Unexpected full session'); } };
    next();
  });
  app.use('/mfa', require('../src/platform/routes/mfa.routes'));
  app.use((error, req, res, next) => { res.status(error.status || 500).json({ code: error.code }); });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    for (const fixture of [{ key: crypto.randomBytes(32).toString('hex'), code: 'MFA_SECRET_UNAVAILABLE' },
      { key: undefined, code: 'MFA_KEY_MISSING' }]) {
      if (fixture.key === undefined) delete process.env.MFA_ENCRYPTION_KEY; else process.env.MFA_ENCRYPTION_KEY = fixture.key;
      const response = await fetch(`http://127.0.0.1:${server.address().port}/mfa/challenge`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: mfa.counterCode(secret, Math.floor(Date.now() / 30000)) })
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: fixture.code });
    }
    assert.equal(writes, 0);
    assert.equal(fullSessions, 0);
    assert.equal(account.mfaSecretEncrypted, encrypted);
    assert.equal(account.mfaLastCounter, -1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
