'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const PasswordReset = require('../models/PasswordReset');
const AccountIdentity = require('../models/AccountIdentity');
const PlatformAdmin = require('../models/PlatformAdmin');
const Tenant = require('../models/Tenant');
const SecurityEvent = require('../models/SecurityEvent');
const { validatePassword, normalizeEmail } = require('./authentication.service');
const { digest } = require('./securityEvent.service');
const { getTenantConnection } = require('../../config/mongo');
const { tenantUserModel } = require('../../tenant/models');
const { sendMail } = require('../../config/mail');
const { appUrl } = require('../../config/env');
const { consumeRecoveryAttempt } = require('./loginThrottle.service');

function invalid() { const err = new Error('Reset link is invalid or expired. Request a new one.'); err.status = 400; return err; }
function unavailable() { const err = new Error('Password recovery email could not be delivered. Please contact support.'); err.status = 503; return err; }
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

async function requestReset(email, ip) {
  const normalized = normalizeEmail(email);
  await consumeRecoveryAttempt(normalized, ip);
  if (!normalized) return;
  const identity = await AccountIdentity.findOne({ email: normalized }).lean();
  if (!identity) return; // Never reveal account existence through response text.

  // Verify the identity still points to an active account before sending a link.
  let active;
  if (identity.kind === 'platform') {
    active = await PlatformAdmin.exists({ _id: identity.accountId, email: normalized, status: 'active' });
  } else if (identity.kind === 'tenant' && identity.tenantId) {
    const tenant = await Tenant.findOne({ _id: identity.tenantId, status: { $in:['active','trial','past_due'] } }).lean();
    if (tenant) active = await tenantUserModel(getTenantConnection(tenant.slug)).exists({ _id: identity.accountId, email: normalized, status: 'active' });
  }
  if (!active) return;
  const token = crypto.randomBytes(32).toString('hex');
  const reset = await PasswordReset.create({ identityId: identity._id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 15 * 60 * 1000) });
  const link = `${appUrl}/reset-password#token=${token}`;
  try {
    await SecurityEvent.create({ action:'auth.password_reset.requested', subjectHash:digest(normalized), ipHash:digest(ip), identityId:identity._id });
    await sendMail({ idempotencyKey: `cfh-reset-${reset._id}`, to: normalized, subject: 'Reset your ClassicFin Hub password',
      text: `A password reset was requested for your ClassicFin Hub account.\n\nOpen this secure link within 15 minutes:\n${link}\n\nIf you did not request this, ignore this email. No password change has been made.` });
  } catch {
    await PasswordReset.deleteOne({ _id: reset._id }).catch(() => {});
    throw unavailable();
  }
}

async function completeReset(token, password, confirmation, ip) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !validatePassword(password) || password !== confirmation) throw invalid();
  const passwordHash = await bcrypt.hash(password, 12);
  let notifyEmail = null;
  let notifyIdentityId = null;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const reset = await PasswordReset.findOne({ tokenHash:hashToken(token), expiresAt:{ $gt:new Date() } }).session(session);
      if (!reset) throw invalid();
      const identity = await AccountIdentity.findById(reset.identityId).session(session);
      if (!identity) throw invalid();
      let result;
      if (identity.kind === 'platform') {
        result = await PlatformAdmin.updateOne({ _id:identity.accountId, email:identity.email, status:'active' },
          { $set:{passwordHash}, $inc:{authVersion:1} }, { session });
      } else if (identity.kind === 'tenant' && identity.tenantId) {
        const tenant = await Tenant.findOne({ _id:identity.tenantId, status:{ $in:['active','trial','past_due'] } }).session(session);
        if (!tenant) throw invalid();
        result = await tenantUserModel(getTenantConnection(tenant.slug)).updateOne({ _id:identity.accountId, email:identity.email, status:'active' },
          { $set:{passwordHash}, $inc:{authVersion:1} }, { session });
      }
      if (result?.modifiedCount !== 1) throw invalid();
      // Invalidate all outstanding reset links and all previous app sessions
      // through authVersion, checked on each protected request.
      await PasswordReset.deleteMany({ identityId:identity._id }, { session });
      await SecurityEvent.create([{ action:'auth.password_reset.completed', subjectHash:digest(identity.email), ipHash:digest(ip), identityId:identity._id }], { session });
      notifyEmail = identity.email; notifyIdentityId = identity._id;
    });
  } finally { await session.endSession(); }
  try {
    await sendMail({ to: notifyEmail, subject: 'Your ClassicFin Hub password was changed',
      text: 'Your ClassicFin Hub password was changed. If you did not authorize this action, contact platform support immediately. Existing sessions were revoked.' });
  } catch {
    console.error('Password change security notification could not be delivered');
    await SecurityEvent.create({ action:'auth.password_reset.notification_failed',subjectHash:digest(notifyEmail),ipHash:digest(ip),identityId:notifyIdentityId }).catch(() => {});
  }
}
module.exports = { requestReset, completeReset, hashToken, invalid };
