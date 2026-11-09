const { validAuthAge } = require('./authSessionExpiry');
const { requiresTenantMfa } = require('../config/roles');
const mfaPolicy = require('../config/mfaPolicy');
const { getTenantConnection } = require('../config/mongo');
const AccountIdentity = require('../platform/models/AccountIdentity');
const { tenantUserModel } = require('../tenant/models');
const { permissionsFor } = require('../config/roles');
function createRequireAuth({getConnection=getTenantConnection,getUserModel=tenantUserModel,identityExists=filter=>AccountIdentity.exists(filter),getBranchModel=conn=>require('../tenant/models').branchModel(conn)}={}) {
return async function requireAuth(req, res, next) {
  try {
    if (!req.tenant || !req.session.tenantUserId || !req.session.identityId || !validAuthAge(req.session.authenticatedAt)) return res.redirect(303, '/signin');
    req.tenantDb = getConnection(req.tenant.slug);
    const User = getUserModel(req.tenantDb);
    const account = await User.findOne({ _id: req.session.tenantUserId, status: 'active' }).lean();
    if (!account || (account.authVersion || 0) !== req.session.authVersion) return res.status(401).send('Access revoked. Sign in again.');
    if (mfaPolicy.enabled() && requiresTenantMfa(account.role) && (!account.mfaEnabledAt || !validAuthAge(req.session.mfaVerifiedAt))) return res.status(401).send('Privileged access requires authenticator verification. Sign in again.');
    const identity = await identityExists({ _id: req.session.identityId, kind: 'tenant', tenantId: req.tenant._id, accountId: account._id, email: account.email });
    if (!identity) return res.status(401).send('Access revoked. Sign in again.');
    // Existing staff retain only their previous role-derived live module access until reassigned.
    const { assignableModules } = require('../tenant/services/moduleAccess.service');
    const legacyModules = account.role === 'Tenant Owner' ? assignableModules(req.tenant,account.role) : [];
    req.user = { id: String(account._id), name: account.name, email: account.email, role: account.role, authVersion: account.authVersion || 0, permissions: permissionsFor(account.role), branchId: account.branchId || null, allowedModules: account.allowedModules == null ? legacyModules : account.allowedModules };
    if (account.role!=='Tenant Owner') {
      if(!/^[a-f0-9]{24}$/i.test(String(account.branchId || ''))) return res.status(403).send('Staff branch assignment is required. Contact your tenant owner.');
      const activeBranch = await getBranchModel(req.tenantDb).exists({_id:account.branchId,status:'active'});
      if(!activeBranch) return res.status(403).send('Assigned branch is unavailable. Contact your tenant owner.');
    }
    if (req.tenant.status === 'past_due' && !req.path.startsWith('/billing')) return res.status(403).send('Subscription restricted. Contact billing support.');
    next();
  } catch (e) { next(e); }
};
}
module.exports = createRequireAuth();
module.exports.createRequireAuth=createRequireAuth;
