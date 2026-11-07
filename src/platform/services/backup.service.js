'use strict';
// Full replica-set backups only. Each archive includes the oplog and all tenant databases.
// Database Tools >=100.3 required for --config (prevents URI/password exposure in argv).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAGIC = Buffer.from('CFHBAK01');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;
const ALLOWED_LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

function validateSourceUri(uri) {
  if (!uri || typeof uri !== 'string' || !uri.startsWith('mongodb://')) throw new Error('Full replica-set backup requires a mongodb:// BACKUP_SOURCE_URI');
  // The official parser accepts replica-set seed lists; WHATWG URL does not
  // support multiple host:port authorities used by real MongoDB deployments.
  const authority = /^mongodb:\/\/[^/]+(\/[^?]*)?(?:\?.*)?$/.exec(uri);
  if (!authority) throw new Error('Invalid full replica-set backup URI');
  const options = new (require('mongoose').mongo.MongoClient)(uri).options;
  if (authority[1] && authority[1] !== '/') throw new Error('BACKUP_SOURCE_URI must not select one database: full replica-set backup required');
  if (options.credentials?.mechanism === 'MONGODB-X509') {
    throw new Error('Certificate-based backup authentication requires a separately reviewed configuration');
  }
  return uri;
}
function assertSafeRestoreTarget(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('mongodb://')) throw new Error('Restore rehearsal requires a mongodb:// URI');
  const parsed = new URL(uri);
  if (!ALLOWED_LOCAL.has(parsed.hostname) || parsed.port !== '27019' || parsed.searchParams.get('replicaSet') !== 'rs-restore') {
    throw new Error('Restore rehearsal allowed only on loopback port 27019 with replicaSet=rs-restore');
  }
  if (parsed.pathname && parsed.pathname !== '/' && parsed.pathname !== '/admin') throw new Error('Restore URI must not select an application database');
  return uri;
}
async function loadEncryptionKey(filename) {
  if (!filename || !path.isAbsolute(filename)) throw new Error('BACKUP_KEY_FILE must be an absolute path to a dedicated 0600 key file');
  const stat = await fsp.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('BACKUP_KEY_FILE must be a regular file, not a link');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('BACKUP_KEY_FILE must not be readable by group or other users (chmod 600)');
  const bytes = await fsp.readFile(filename);
  const trimmed = bytes.toString('utf8').trim();
  const key = /^[a-fA-F0-9]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : bytes;
  if (key.length !== 32) throw new Error('BACKUP_KEY_FILE must contain exactly 32 random bytes or 64 hex characters');
  return key;
}
async function privateDirectory(root, create = false) {
  if (!root || !path.isAbsolute(root)) throw new Error('Backup storage path must be absolute');
  if (create) await fsp.mkdir(root, {recursive: true, mode: 0o700});
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Backup directory must be a real directory');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Backup directory must be owner-only (chmod 700)');
}
async function withToolConfig(uri, action) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cfh-dbtool-'));
  await fsp.chmod(dir, 0o700);
  const filename = path.join(dir, 'mongotool.yml');
  try {
    // JSON string is also a valid YAML scalar. No credential is passed as an argv value.
    await fsp.writeFile(filename, `uri: ${JSON.stringify(uri)}\n`, {mode: 0o600, flag: 'wx'});
    return await action(filename);
  } finally {
    await fsp.rm(dir, {recursive: true, force: true});
  }
}
function runTool(binary, args) {
  // Explicitly supplied Node-based test fixtures must be executed through Node on
  // Windows (which cannot spawn a shebang-only JS file). Normal mongodump and
  // mongorestore executables still run directly, with shell execution disabled.
  const nodeScript = typeof binary === 'string' && /\.(?:cjs|js)$/.test(binary);
  const command = nodeScript ? process.execPath : binary;
  const commandArgs = nodeScript ? [binary, ...args] : args;
  const child = spawn(command, commandArgs, {stdio: ['pipe', 'pipe', 'pipe'], shell: false});
  // Drain stderr but never echo it: MongoDB tools can include connection strings.
  child.stderr.on('data', () => {});
  const done = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Database Tools executable could not start')));
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  // The encrypted stream can fail before the caller awaits process completion.
  // Attach a handler immediately to avoid a transient unhandled rejection, while
  // preserving the original rejected promise for the caller to observe.
  done.catch(() => {});
  return {child, done};
}
async function createBackup({sourceUri, outputDir, key, dumpBinary = 'mongodump', now = new Date()} = {}) {
  validateSourceUri(sourceUri);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Backup encryption key must be 32 bytes');
  await privateDirectory(outputDir, true);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const base = `classicfin-full-${stamp}-${crypto.randomUUID()}.cfhb`;
  const target = path.join(outputDir, base);
  const partial = `${target}.partial`;
  let child;
  try {
    await withToolConfig(sourceUri, async config => {
      const proc = runTool(dumpBinary, ['--config', config, '--oplog', '--archive', '--gzip', '--quiet']);
      child = proc.child;
      child.stdin.end();
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const header = Buffer.concat([MAGIC, iv]);
      async function* chunks() {
        yield header;
        for await (const chunk of child.stdout) {
          const encrypted = cipher.update(chunk);
          if (encrypted.length) yield encrypted;
        }
        const last = cipher.final();
        if (last.length) yield last;
        yield cipher.getAuthTag();
      }
      try {
        await pipeline(Readable.from(chunks()), fs.createWriteStream(partial, {flags: 'wx', mode: 0o600}));
        const result = await proc.done;
        if (result.code !== 0 || result.signal) throw new Error('mongodump failed; partial encrypted archive discarded');
      } catch (err) {
        child.kill('SIGTERM');
        await proc.done.catch(() => {});
        throw err;
      }
    });
    await verifyBackup({filename: partial, key});
    await fsp.rename(partial, target);
    return {filename: target, bytes: (await fsp.stat(target)).size, encrypted: true, oplog: true};
  } catch (error) {
    if (child && !child.killed) child.kill('SIGTERM');
    await fsp.rm(partial, {force: true}).catch(() => {});
    throw error;
  }
}
async function inspectEncryptedFile(filename) {
  const stat = await fsp.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= HEADER_BYTES + TAG_BYTES) throw new Error('Invalid or empty encrypted backup file');
  const file = await fsp.open(filename, 'r');
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    await file.read(header, 0, HEADER_BYTES, 0);
    await file.read(tag, 0, TAG_BYTES, stat.size - TAG_BYTES);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Unsupported backup format');
    return {iv: header.subarray(MAGIC.length), tag, size: stat.size, mtimeMs: stat.mtimeMs};
  } finally { await file.close(); }
}
async function decryptBackup({filename, key, onChunk = async () => {}}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Backup encryption key must be 32 bytes');
  const {iv, tag, size, mtimeMs} = await inspectEncryptedFile(filename);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plaintextBytes = 0;
  for await (const chunk of fs.createReadStream(filename, {start: HEADER_BYTES, end: size - TAG_BYTES - 1})) {
    const plain = decipher.update(chunk);
    plaintextBytes += plain.length;
    if (plain.length) await onChunk(plain);
  }
  const last = decipher.final(); // Authentication failure must block verification/restore.
  plaintextBytes += last.length;
  if (last.length) await onChunk(last);
  if (plaintextBytes === 0) throw new Error('Backup archive has no content');
  const latest = await fsp.stat(filename);
  if (latest.size !== size || latest.mtimeMs !== mtimeMs) throw new Error('Backup changed while being verified');
  return {plaintextBytes, encrypted: true, authenticated: true};
}
async function verifyBackup({filename, key}) {
  return decryptBackup({filename, key});
}
async function assertEmptyRestoreCluster(uri) {
  assertSafeRestoreTarget(uri);
  const { MongoClient } = require('mongoose').mongo;
  const client = new MongoClient(uri, {serverSelectionTimeoutMS: 5000});
  try {
    await client.connect();
    const hello = await client.db('admin').command({hello: 1});
    if (hello.setName !== 'rs-restore' || !hello.isWritablePrimary) throw new Error('Restore target is not the dedicated writable rs-restore replica set');
    const databaseList = await client.db('admin').admin().listDatabases();
    const existing = databaseList.databases.filter(db => !['admin', 'config', 'local'].includes(db.name));
    if (existing.length) throw new Error('Restore rehearsal target is not empty; use a new isolated replica set');
  } finally { await client.close(); }
}
// Verify application structures after a real restore, not merely the mongorestore exit code.
// This is read-only and returns aggregate counts without exposing customer records.
const RESTORED_UNIQUE_INDEXES = Object.freeze({
  securetenantusers: 'email', securebranches: 'code',
  securestaffinvites: 'tokenHash', securemobiletransactions: 'idempotencyKey'
});
function hasUniqueSingleFieldIndex(indexes, field) {
  return indexes.some(index => index.unique === true && Object.keys(index.key || {}).length === 1 && index.key[field] === 1);
}
async function inspectRestoredApplication(targetUri) {
  assertSafeRestoreTarget(targetUri);
  const { MongoClient } = require('mongoose').mongo;
  const client = new MongoClient(targetUri, {serverSelectionTimeoutMS: 5000});
  try {
    await client.connect();
    const names = new Set((await client.db('admin').admin().listDatabases()).databases.map(entry => entry.name));
    if (!names.has('classicfin_platform_db')) throw new Error('Restored platform database missing');
    const platform = client.db('classicfin_platform_db');
    const emailIndexes = await platform.collection('accountidentities').indexes();
    if (!hasUniqueSingleFieldIndex(emailIndexes, 'email')) throw new Error('Restored global email identity unique index missing');
    const tenants = await platform.collection('tenants').find({}, {projection: {slug: 1,dbName: 1}}).toArray();
    if (tenants.length > 100000) throw new Error('Restored tenant verification exceeds safe inspection limit');
    let verifiedTenants = 0;
    for (const tenant of tenants) {
      const slug = tenant.slug;
      if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug || '')) throw new Error('Invalid tenant slug found in restored platform database');
      const expected = `classicfin_tenant_${slug.replace(/-/g, '_')}_db`;
      if (tenant.dbName !== expected || !names.has(expected)) throw new Error('Restored tenant database mapping is inconsistent');
      const db = client.db(expected);
      for (const [collection, field] of Object.entries(RESTORED_UNIQUE_INDEXES)) {
        const indexes = await db.collection(collection).indexes();
        if (!hasUniqueSingleFieldIndex(indexes, field)) throw new Error('Required tenant financial/identity uniqueness index missing after restore');
      }
      verifiedTenants++;
    }
    return {platformDatabasePresent: true, globalEmailIdentityIndex: true, tenantDatabasesVerified: verifiedTenants};
  } finally { await client.close(); }
}
async function rehearseBackup({filename, key, targetUri, restoreBinary = 'mongorestore', checkTarget = assertEmptyRestoreCluster, inspectData = inspectRestoredApplication} = {}) {
  assertSafeRestoreTarget(targetUri);
  await checkTarget(targetUri);
  await verifyBackup({filename, key}); // Authenticate before applying ANY data to scratch MongoDB.
  return withToolConfig(targetUri, async config => {
    const {child, done} = runTool(restoreBinary, ['--config', config, '--archive', '--gzip', '--oplogReplay', '--stopOnError', '--quiet']);
    let streamFailure;
    try {
      await decryptBackup({filename, key, onChunk: async bytes => {
        if (!child.stdin.write(bytes)) await once(child.stdin, 'drain');
      }});
      child.stdin.end();
    } catch (error) {
      streamFailure = error;
      child.stdin.destroy();
      child.kill('SIGTERM');
    }
    const status = await done;
    if (streamFailure) throw new Error('Restore rehearsal failed to decrypt or stream backup');
    if (status.code !== 0 || status.signal) throw new Error('mongorestore rehearsal failed');
    const application = await inspectData(targetUri);
    return {restoredTo: 'isolated loopback replica set', oplogReplayed: true, application};
  });
}
module.exports = {MAGIC, validateSourceUri, assertSafeRestoreTarget, loadEncryptionKey, createBackup, verifyBackup, rehearseBackup, assertEmptyRestoreCluster, inspectRestoredApplication, hasUniqueSingleFieldIndex, decryptBackup};
