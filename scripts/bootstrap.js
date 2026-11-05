#!/usr/bin/env node
'use strict';
// Explicit, one-time administrator provisioning. Never seeds demo credentials.
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { validatePassword, normalizeEmail } = require('../src/platform/services/authentication.service');
const { connectPlatformMongo } = require('../src/config/mongo');
const { verifyReplicaPrimary } = require('../src/config/mongoTopology');
const PlatformAdmin = require('../src/platform/models/PlatformAdmin');
const AccountIdentity = require('../src/platform/models/AccountIdentity');
const BootstrapMarker = require('../src/platform/models/BootstrapMarker');
const mongoose = require('mongoose');

async function main() {
  const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const name = String(process.env.BOOTSTRAP_ADMIN_NAME || 'Platform Administrator').trim();
  const filename = process.env.BOOTSTRAP_PASSWORD_FILE;
  if (!email || !filename || name.length < 2 || name.length > 120) throw new Error('Set a valid BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME and BOOTSTRAP_PASSWORD_FILE');
  const stat = fs.statSync(filename);
  if (!stat.isFile()) throw new Error('Bootstrap password must come from a regular local file');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Password file must be owner-only (chmod 600)');
  const password = fs.readFileSync(filename, 'utf8').replace(/\r?\n$/, '');
  if (!validatePassword(password)) throw new Error('Admin password requires 14+ characters, uppercase, lowercase, digit and symbol, up to 72 UTF-8 bytes');
  await connectPlatformMongo();
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  verifyReplicaPrimary(hello);
  for (const model of [PlatformAdmin, AccountIdentity, BootstrapMarker]) await model.createIndexes();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (await PlatformAdmin.exists({}).session(session) || await AccountIdentity.exists({ email }).session(session)) {
        throw new Error('Administrator already exists or email already registered. Use the account migration process, not bootstrap.');
      }
      // A unique marker prevents two concurrent first-admin commands from succeeding.
      await BootstrapMarker.create([{ _id: 'first-platform-admin' }], { session });
      const [account] = await PlatformAdmin.create([{ name, email, passwordHash: await bcrypt.hash(password, 12), role: 'Super Admin', status: 'active' }], { session });
      await AccountIdentity.create([{ email, kind: 'platform', accountId: account._id }], { session });
    });
  } finally { await session.endSession(); }
  console.log('Initial Super Admin created. Delete the password file securely and sign in with email + password.');
}
main().catch(err => { console.error('Bootstrap refused:', err.message); process.exitCode = 1; }).finally(() => mongoose.disconnect().catch(() => {}));
