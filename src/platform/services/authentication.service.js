'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const AccountIdentity = require('../models/AccountIdentity');
const PlatformAdmin = require('../models/PlatformAdmin');
const Tenant = require('../models/Tenant');
const OwnerInvite = require('../models/OwnerInvite');
const { getTenantConnection } = require('../../config/mongo');
const { tenantUserModel, ensureTenantIndexes } = require('../../tenant/models');
const DUMMY_HASH = '$2a$12$hMfLjKJh2XKGf7n6v.QS7OS4TfJbOodYP8v8DpS.UO7wzKOtVDpA2';
// bcrypt authenticates only the first 72 UTF-8 bytes. Reject larger inputs
// before hashing or comparison so a password's suffix is never silently ignored.
const MAX_PASSWORD_BYTES = 72;

function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  const result = email.trim().toLowerCase();
  return result.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result) ? result : '';
}

function createAuthenticator({ Identity = AccountIdentity, Admin = PlatformAdmin, TenantModel = Tenant, getUserModel = tenantUserModel, tenantConnection = getTenantConnection } = {}) {
  return async function authenticate({ email, password } = {}) {
  const loginEmail = normalizeEmail(email);
  const pwd = typeof password === 'string' ? password : '';
  if (!loginEmail || !pwd || Buffer.byteLength(pwd, 'utf8') > MAX_PASSWORD_BYTES) {
    await bcrypt.compare('invalid', DUMMY_HASH);
    return null;
  }

  // Global UNIQUE directory lookup. Never take a tenant name, role or dashboard
  // choice from browser input; the directory is written atomically on activation.
  const identity = await Identity.findOne({ email: loginEmail }).lean();
  let account = null;
  let tenant = null;
  if (identity?.kind === 'platform' && !identity.tenantId) {
    account = await Admin.findOne({ _id: identity.accountId, email: loginEmail, status: 'active' }).lean();
    if (account?.role !== 'Super Admin' || account?.status !== 'active' || account?.email !== loginEmail) account = null;
  } else if (identity?.kind === 'tenant' && identity.tenantId) {
    tenant = await TenantModel.findOne({ _id: identity.tenantId, status: { $in: ['active', 'trial', 'past_due'] } }).lean();
    if (tenant && ['active','trial','past_due'].includes(tenant.status)) {
      // The tenant slug always comes from a stored platform record, not the user.
      const User = getUserModel(tenantConnection(tenant.slug));
      account = await User.findOne({ _id: identity.accountId, email: loginEmail, status: 'active' }).lean();
      if (account?.status !== 'active' || account?.email !== loginEmail) account = null;
    } else tenant = null;
  }

  const matches = await bcrypt.compare(pwd, account?.passwordHash || DUMMY_HASH);
  if (!matches || !account || !identity) return null;
  if (identity.kind === 'platform') return { platformId: String(account._id), identityId: String(identity._id), authVersion: account.authVersion || 0 };
  if (identity.kind === 'tenant' && tenant) return {
    tenantId: String(tenant._id), tenantUserId: String(account._id), identityId: String(identity._id), authVersion: account.authVersion || 0,
    mfaRequired: require('../../config/mfaPolicy').enabled()&&require('../../config/roles').requiresTenantMfa(account.role), mfaEnrolled: Boolean(account.mfaEnabledAt)
  };
  return null;
  };
}
const authenticate = createAuthenticator();

function validatePassword(pwd) {
  return typeof pwd === 'string' && pwd.length >= 14 && Buffer.byteLength(pwd, 'utf8') <= MAX_PASSWORD_BYTES &&
    /[A-Z]/.test(pwd) && /[a-z]/.test(pwd) && /\d/.test(pwd) && /[^A-Za-z\d]/.test(pwd);
}

function conflictError() {
  const e = new Error('This email already belongs to an account. Use a different email or contact support.');
  e.status = 409; return e;
}
async function acceptInvite(token, password) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !validatePassword(password)) {
    const e = new Error('Invalid invitation or password. Use 14+ characters with mixed case, numbers and a symbol, up to 72 UTF-8 bytes.'); e.status = 400; throw e;
  }
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  let tenant;
  try {
    await session.withTransaction(async () => {
      const invite = await OwnerInvite.findOne({ tokenHash: hash, usedAt: null, expiresAt: { $gt: new Date() } }).session(session);
      if (!invite) { const e = new Error('Invitation is invalid, expired or already used.'); e.status = 400; throw e; }
      tenant = await Tenant.findById(invite.tenantId).session(session);
      if (!tenant || tenant.status === 'suspended') throw new Error('Tenant is not available');
      if (!normalizeEmail(invite.email) || await AccountIdentity.exists({ email: invite.email }).session(session)) throw conflictError();
      const conn = getTenantConnection(tenant.slug);
      await ensureTenantIndexes(conn);
      const User = tenantUserModel(conn);
      const [account] = await User.create([{ name: invite.name, email: invite.email, passwordHash: await bcrypt.hash(password, 12),
        role: 'Tenant Owner', permissions: ['*'], status: 'active' }], { session });
      await AccountIdentity.create([{ email: invite.email, kind: 'tenant', accountId: account._id, tenantId: tenant._id }], { session });
      tenant.setupStatus = 'complete';
      await tenant.save({ session });
      invite.usedAt = new Date();
      await invite.save({ session });
    });
  } catch (e) {
    if (e.code === 11000) throw conflictError();
    throw e;
  } finally { await session.endSession(); }
  return tenant;
}
module.exports = { authenticate, createAuthenticator, acceptInvite, validatePassword, normalizeEmail, MAX_PASSWORD_BYTES };
