const { validAuthAge } = require('./authSessionExpiry');
const PlatformAdmin = require('../platform/models/PlatformAdmin');
const AccountIdentity = require('../platform/models/AccountIdentity');
module.exports = async function requirePlatformAuth(req, res, next) {
  try {
    if (!req.session.platformId || !req.session.identityId || !validAuthAge(req.session.authenticatedAt) || !validAuthAge(req.session.mfaVerifiedAt)) return res.redirect(303, '/signin');
    const account = await PlatformAdmin.findOne({ _id: req.session.platformId, status: 'active' }).lean();
    if (!account || !account.mfaEnabledAt || account.role !== 'Super Admin' || (account.authVersion || 0) !== req.session.authVersion) return res.status(401).send('Access revoked. Sign in again.');
    const identity = await AccountIdentity.exists({ _id: req.session.identityId, kind: 'platform', accountId: account._id, email: account.email, tenantId: null });
    if (!identity) return res.status(401).send('Access revoked. Sign in again.');
    req.platformUser = { id: String(account._id), name: account.name, role: account.role, authVersion:account.authVersion||0, permissions: account.role === 'Super Admin' ? ['*'] : [] };
    next();
  } catch (e) { next(e); }
};
