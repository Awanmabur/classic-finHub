#!/usr/bin/env node
'use strict';
/**
 * Offline, dual-credential MFA recovery for a privileged tenant user.
 * This is an authorized support procedure, not a web endpoint.
 * Requires a verified platform admin password, the affected user's CURRENT
 * password, an incident/case ID, and an exact acknowledgement. Writes an audit
 * event in the same transaction as revoking every existing user session.
 */
const fs = require('node:fs');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { connectPlatformMongo, getTenantConnection } = require('../src/config/mongo');
const { verifyReplicaPrimary } = require('../src/config/mongoTopology');
const { normalizeEmail } = require('../src/platform/services/authentication.service');
const { requiresTenantMfa } = require('../src/config/roles');
const { authVersionFilter } = require('../src/platform/services/mfa.service');
const Admin = require('../src/platform/models/PlatformAdmin');
const AccountIdentity = require('../src/platform/models/AccountIdentity');
const Tenant = require('../src/platform/models/Tenant');
const SecurityEvent = require('../src/platform/models/SecurityEvent');
const PlatformAuditLog = require('../src/platform/models/PlatformAuditLog');
const { auditEventModel, tenantUserModel } = require('../src/tenant/models');
const { digest } = require('../src/platform/services/securityEvent.service');

function readProtectedPassword(file) {
  if (typeof file !== 'string' || !file) throw new Error('Both private password files are mandatory');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
    throw new Error('Password file must be a regular owner-only file, not a symlink (chmod 600)');
  }
  return fs.readFileSync(file,'utf8').replace(/\r?\n$/, '');
}
function checkedEnvironment(env=process.env) {
  const adminEmail=normalizeEmail(env.MFA_TENANT_RECOVERY_ADMIN_EMAIL);
  const targetEmail=normalizeEmail(env.MFA_TENANT_RECOVERY_TARGET_EMAIL);
  const caseId=env.MFA_TENANT_RECOVERY_CASE;
  if (!adminEmail || !targetEmail || adminEmail === targetEmail ||
      typeof caseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(caseId) ||
      env.MFA_TENANT_RECOVERY_CONFIRM !== `RESET TENANT MFA FOR ${targetEmail}`) {
    throw new Error('Require different admin/target email addresses, a documented recovery case ID, and exact RESET TENANT MFA FOR <target-email> approval');
  }
  return {adminEmail,targetEmail,caseId};
}
async function main() {
  const {adminEmail,targetEmail,caseId}=checkedEnvironment();
  const adminPassword=readProtectedPassword(process.env.MFA_TENANT_RECOVERY_ADMIN_PASSWORD_FILE);
  const targetPassword=readProtectedPassword(process.env.MFA_TENANT_RECOVERY_TARGET_PASSWORD_FILE);
  await connectPlatformMongo();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
  const admin=await Admin.findOne({email:adminEmail,role:'Super Admin',status:'active'}).lean();
  const mapping=await AccountIdentity.findOne({email:targetEmail,kind:'tenant'}).lean();
  const tenant=mapping?.tenantId && await Tenant.findOne({_id:mapping.tenantId,status:{$in:['active','trial','past_due']}}).lean();
  const User=tenant && tenantUserModel(getTenantConnection(tenant.slug));
  const target=User && await User.findOne({_id:mapping.accountId,email:targetEmail,status:'active'}).lean();
  // Never explain which credential failed to callers. Both must match.
  if (!admin || !target || !requiresTenantMfa(target.role) || !target.mfaEnabledAt ||
      !await bcrypt.compare(adminPassword,admin.passwordHash) ||
      !await bcrypt.compare(targetPassword,target.passwordHash)) {
    throw new Error('Recovery denied: administrator and account credentials were not verified');
  }
  if (!process.argv.includes('--apply')) {
    console.log('DRY RUN: both passwords verified, identity/tenant mapping valid, MFA enabled. Supply --apply only after independent identity verification and approval.');
    return;
  }
  const session=await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (!await Admin.exists({_id:admin._id,status:'active',role:'Super Admin',authVersion:authVersionFilter(admin.authVersion||0)}).session(session) ||
          !await AccountIdentity.exists({_id:mapping._id,accountId:target._id,tenantId:tenant._id,email:targetEmail}).session(session)) {
        throw new Error('Recovery rejected: account identity changed');
      }
      const updated=await User.updateOne({_id:target._id,email:targetEmail,status:'active',authVersion:authVersionFilter(target.authVersion||0),mfaEnabledAt:{$ne:null}},
        {$set:{mfaSecretEncrypted:null,mfaEnabledAt:null,mfaLastCounter:-1},$inc:{authVersion:1}}, {session});
      if (updated.modifiedCount !== 1) throw new Error('Recovery rejected: account changed or MFA already reset');
      await SecurityEvent.create([{
        action:'auth.tenant_mfa.break_glass_reset',subjectHash:digest(targetEmail),ipHash:digest('offline-support'),identityId:mapping._id
      }],{session});
      await PlatformAuditLog.create([{actorId:String(admin._id),actorName:'Verified offline platform administrator',
        action:'auth.tenant_mfa.break_glass_reset',moduleKey:'security',recordId:String(target._id)}],{session});
      await auditEventModel(getTenantConnection(tenant.slug)).create([{
        action:'auth.tenant_mfa.break_glass_reset',actorId:admin._id,targetId:target._id,metadata:{recoveryCaseId:caseId}
      }],{session});
    });
  } finally { await session.endSession(); }
  console.log('Tenant MFA recovery applied and audited. Existing sessions are revoked; the user must enroll a fresh authenticator.');
}
if (require.main === module) {
  main().catch(err=>{console.error('Tenant MFA recovery REFUSED:',err.message);process.exitCode=1;})
    .finally(()=>mongoose.disconnect().catch(()=>{}));
}
module.exports={checkedEnvironment,readProtectedPassword,main};
