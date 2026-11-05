#!/usr/bin/env node
'use strict';
// Privileged, offline administrative break-glass procedure. Requires server shell
// access, the administrator's current password, a protected file and explicit
// acknowledgement. All prior admin sessions are invalidated.
const fs = require('fs');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { connectPlatformMongo } = require('../src/config/mongo');
const { verifyReplicaPrimary } = require('../src/config/mongoTopology');
const { normalizeEmail } = require('../src/platform/services/authentication.service');
const Admin = require('../src/platform/models/PlatformAdmin');
const SecurityEvent = require('../src/platform/models/SecurityEvent');
const PlatformAuditLog = require('../src/platform/models/PlatformAuditLog');
const { digest } = require('../src/platform/services/securityEvent.service');
async function run() {
  const email = normalizeEmail(process.env.MFA_RECOVERY_EMAIL);
  const file = process.env.MFA_RECOVERY_PASSWORD_FILE;
  if (!email || !file || process.env.MFA_RECOVERY_CONFIRM !== `RESET MFA FOR ${email}`)
    throw new Error('Provide MFA_RECOVERY_EMAIL, MFA_RECOVERY_PASSWORD_FILE and exact MFA_RECOVERY_CONFIRM=RESET MFA FOR <email>');
  const stat = fs.statSync(file);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Password file must be owner-only (chmod 600)');
  const password = fs.readFileSync(file,'utf8').replace(/\r?\n$/,'');
  await connectPlatformMongo();
  const hello = await mongoose.connection.db.admin().command({hello:1});
  verifyReplicaPrimary(hello);
  const admin = await Admin.findOne({email,status:'active'}).select('passwordHash mfaEnabledAt').lean();
  if (!admin || !await bcrypt.compare(password,admin.passwordHash)) throw new Error('Administrator credentials were not verified');
  if (!admin.mfaEnabledAt) throw new Error('MFA is not enabled for this administrator');
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async()=>{
      const result=await Admin.updateOne({_id:admin._id,status:'active',mfaEnabledAt:{$ne:null}},
        {$set:{mfaSecretEncrypted:null,mfaEnabledAt:null,mfaLastCounter:-1},$inc:{authVersion:1}}, {session});
      if (result.modifiedCount !== 1) throw new Error('MFA reset failed or was already processed');
      await SecurityEvent.create([{action:'auth.mfa.break_glass_reset',subjectHash:digest(email),identityId:null}],{session});
      await PlatformAuditLog.create([{ actorId:String(admin._id), actorName:'Offline recovery (password verified)', action:'auth.mfa.break_glass_reset', moduleKey:'security', recordId:String(admin._id) }],{session});
    });
  } finally { await session.endSession(); }
  console.log('MFA reset completed. All existing sessions revoked. The administrator must enroll a NEW authenticator on next login.');
}
run().catch(err => { console.error('MFA recovery refused:',err.message);process.exitCode=1; })
  .finally(()=>mongoose.disconnect().catch(()=>{}));
