'use strict';
// MFA is a step after the shared two-field login, never an account/tenant selector.
// Both platform and privileged tenant accounts must complete it before receiving a full session.
const router = require('express').Router();
const PlatformAdmin = require('../models/PlatformAdmin');
const Tenant = require('../models/Tenant');
const AccountIdentity = require('../models/AccountIdentity');
const { getTenantConnection } = require('../../config/mongo');
const { tenantUserModel } = require('../../tenant/models');
const { requiresTenantMfa } = require('../../config/roles');
const { flash, consumeFlash } = require('../../utils/view');
const mfa = require('../services/mfa.service');
const { record: recordSecurityEvent } = require('../services/securityEvent.service');
const { login } = require('../../middleware/rateLimiter');

function requirePending(req, res, next) {
  const pending = mfa.pendingSession(req);
  if (!pending) return res.redirect(303, '/signin');
  if ((pending.attempts || 0) >= mfa.MAX_ATTEMPTS) {
    return req.session.destroy(err => err ? next(err) : res.redirect(303, '/signin'));
  }
  req.pendingMfa = pending;
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}
async function accountContext(pending, withSecret = false) {
  let Model, filter, identityFilter;
  if (pending.platformId) {
    Model = PlatformAdmin;
    filter = { _id: pending.platformId, role: 'Super Admin', status: 'active', authVersion: mfa.authVersionFilter(pending.authVersion) };
    identityFilter = { _id: pending.identityId, kind: 'platform', accountId: pending.platformId, tenantId: null };
  } else {
    // The tenant DB name comes only from a platform record recovered from the signed session.
    const tenant = await Tenant.findOne({ _id: pending.tenantId, status: { $in: ['trial','active','past_due'] } }).lean();
    if (!tenant) return null;
    Model = tenantUserModel(getTenantConnection(tenant.slug));
    filter = { _id: pending.tenantUserId, status: 'active', authVersion: mfa.authVersionFilter(pending.authVersion),
      role: { $in: require('../../config/roles').TENANT_MFA_ROLES } };
    identityFilter = { _id: pending.identityId, kind: 'tenant', accountId: pending.tenantUserId, tenantId: tenant._id };
  }
  const query = Model.findOne(filter);
  const account = await (withSecret ? query.select('+mfaSecretEncrypted') : query).lean();
  if (!account || (pending.platformId ? account.role !== 'Super Admin' : !requiresTenantMfa(account.role))) return null;
  if (!await AccountIdentity.exists({ ...identityFilter, email: account.email })) return null;
  return { Model, account, filter };
}
function beginFullSession(req, account, pending, next, res) {
  req.session.regenerate(err => {
    if (err) return next(err);
    const isPlatform = Boolean(pending.platformId);
    Object.assign(req.session, {
      ...(isPlatform ? { platformId: String(account._id) } :
        { tenantId: pending.tenantId, tenantUserId: String(account._id) }),
      identityId: pending.identityId, authVersion: account.authVersion || 0,
      authenticatedAt: Date.now(), mfaVerifiedAt: Date.now()
    });
    req.session.save(err2 => err2 ? next(err2) : res.redirect(303, isPlatform ? '/platform/dashboard' : '/tenant/dashboard'));
  });
}
function recordFailed(req, pending) {
  return recordSecurityEvent('auth.mfa.failed', { email: pending.accountEmail, ip: req.ip, identityId: pending.identityId });
}
router.use(requirePending);
router.get('/setup', async (req, res, next) => {
  try {
    const pending = req.pendingMfa;
    if (pending.mode !== 'setup') return res.redirect(303, '/mfa/challenge');
    const ctx = await accountContext(pending);
    if (!ctx || ctx.account.mfaEnabledAt) return res.status(401).send('Sign in again.');
    if (!pending.setupSecret) pending.setupSecret = mfa.encryptSecret(mfa.generateSecret());
    const secret = mfa.decryptSecret(pending.setupSecret);
    req.session.save(err => err ? next(err) : res.render('auth/mfa', {
      mode: 'setup', secret, accountEmail: ctx.account.email, flash: consumeFlash(req)
    }));
  } catch(e) { next(e); }
});
router.post('/setup', login, async (req, res, next) => {
  try {
    const pending = req.pendingMfa;
    if (pending.mode !== 'setup' || !pending.setupSecret) return res.redirect(303, '/signin');
    mfa.recordAttempt(pending);
    const ctx = await accountContext(pending);
    if (!ctx || ctx.account.mfaEnabledAt) return res.status(401).send('Sign in again.');
    const counter = mfa.verifyCode(mfa.decryptSecret(pending.setupSecret), req.body.code);
    if (counter === null) {
      await recordFailed(req, pending);
      flash(req, 'bad', 'Invalid authenticator code.');
      return res.redirect(303, '/mfa/setup');
    }
    const account = await ctx.Model.findOneAndUpdate(
      { ...ctx.filter, mfaEnabledAt: null },
      { $set: { mfaSecretEncrypted: pending.setupSecret, mfaEnabledAt: new Date(), mfaLastCounter: counter }, $inc: { authVersion: 1 } },
      { new: true }
    ).lean();
    if (!account) return res.status(409).send('Authenticator setup changed. Sign in again.');
    await recordSecurityEvent('auth.mfa.enrolled', { email: account.email, ip: req.ip, identityId: pending.identityId });
    beginFullSession(req, account, pending, next, res);
  } catch(e) { next(e); }
});
router.get('/challenge', async (req, res, next) => {
  try {
    const pending = req.pendingMfa;
    if (pending.mode !== 'challenge') return res.redirect(303, '/mfa/setup');
    const ctx = await accountContext(pending);
    if (!ctx || !ctx.account.mfaEnabledAt) return res.status(401).send('Sign in again.');
    res.render('auth/mfa', { mode: 'challenge', secret: null, accountEmail: ctx.account.email, flash: consumeFlash(req) });
  } catch(e) { next(e); }
});
router.post('/challenge', login, async (req, res, next) => {
  try {
    const pending = req.pendingMfa;
    if (pending.mode !== 'challenge') return res.redirect(303, '/signin');
    mfa.recordAttempt(pending);
    const ctx = await accountContext(pending, true);
    if (!ctx || !ctx.account.mfaEnabledAt || !ctx.account.mfaSecretEncrypted) return res.status(401).send('Sign in again.');
    const counter = mfa.verifyCode(mfa.decryptSecret(ctx.account.mfaSecretEncrypted), req.body.code, ctx.account.mfaLastCounter ?? -1);
    if (counter === null) {
      await recordFailed(req, pending);
      flash(req, 'bad', 'Invalid or already-used authenticator code.');
      return res.redirect(303, '/mfa/challenge');
    }
    const account = await ctx.Model.findOneAndUpdate(
      { ...ctx.filter, mfaEnabledAt: { $ne: null }, mfaLastCounter: { $lt: counter } },
      { $set: { mfaLastCounter: counter } }, { new: true }
    ).lean();
    if (!account) {
      flash(req, 'bad', 'Code already used. Enter a new code.');
      return res.redirect(303, '/mfa/challenge');
    }
    await recordSecurityEvent('auth.mfa.verified', { email: account.email, ip: req.ip, identityId: pending.identityId });
    beginFullSession(req, account, pending, next, res);
  } catch(e) { next(e); }
});
module.exports = router;
