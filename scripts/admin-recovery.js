#!/usr/bin/env node
'use strict';
/**
 * Controlled offline break-glass recovery for an EXISTING active Super Admin.
 * Does not create administrators or bypass the global identity directory.
 * Run only from an authorized operations host with restricted DB credentials.
 */
const fs = require('fs');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { normalizeEmail, validatePassword } = require('../src/platform/services/authentication.service');
const { connectPlatformMongo } = require('../src/config/mongo');
const { verifyReplicaPrimary } = require('../src/config/mongoTopology');
const Admin = require('../src/platform/models/PlatformAdmin');
const Identity = require('../src/platform/models/AccountIdentity');
const SecurityEvent = require('../src/platform/models/SecurityEvent');
const { digest } = require('../src/platform/services/securityEvent.service');

async function main() {
  const email = normalizeEmail(process.env.ADMIN_RECOVERY_EMAIL);
  const file = process.env.ADMIN_RECOVERY_PASSWORD_FILE;
  if (process.env.ADMIN_RECOVERY_APPROVED !== 'YES' || !email || !file) {
    throw new Error('Require ADMIN_RECOVERY_APPROVED=YES, ADMIN_RECOVERY_EMAIL and ADMIN_RECOVERY_PASSWORD_FILE. See operations guide.');
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('Password file must be regular and restricted to its owner');
  const password = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (!validatePassword(password)) throw new Error('New password does not meet the current password policy');
  await connectPlatformMongo();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({ hello: 1 }));
  const newHash = await bcrypt.hash(password, 12);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const account = await Admin.findOne({ email, role:'Super Admin', status:'active' }).session(session);
      if (!account) throw new Error('An active Super Admin with that email does not exist');
      const identity = await Identity.findOne({ email, kind:'platform', accountId:account._id, tenantId:null }).session(session);
      if (!identity) throw new Error('The administrator is not in the global identity directory. Run the migration instead.');
      const result = await Admin.updateOne({ _id:account._id, role:'Super Admin', status:'active' }, {
        $set:{ passwordHash:newHash }, $inc:{ authVersion:1 }
      }, { session });
      if (result.modifiedCount !== 1) throw new Error('Admin password change was not applied');
      await SecurityEvent.create([{ action:'auth.admin.break_glass_recovery',subjectHash:digest(email),ipHash:digest('offline-operator'),identityId:identity._id }],{session});
    });
  } finally { await session.endSession(); }
  console.log('Existing Super Admin password rotated; old sessions are revoked. Remove the recovery password file.');
}
main().catch(e => { console.error('Admin recovery REFUSED:',e.message);process.exitCode=1; }).finally(()=>mongoose.disconnect().catch(()=>{}));
