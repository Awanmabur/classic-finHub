const Tenant = require('../platform/models/Tenant');
module.exports = async function tenantResolver(req, res, next) {
  try {
    // Tenant selection is bound to the authenticated session, not query strings or headers.
    if (!req.session.tenantId || !req.session.tenantUserId) return res.redirect(303, '/signin');
    const tenant = await Tenant.findOne({ _id: req.session.tenantId }).lean();
    if (!tenant || !['active','trial','past_due','suspended'].includes(tenant.status)) return res.status(403).send('Tenant access unavailable');
    if (!req.path.startsWith('/billing') && (tenant.status==='suspended'||
        (!require('../platform/services/commercial.service').effectiveSubscription(tenant) &&
         !require('../platform/services/moduleSubscriptions.service').activeGrants(tenant).length))) {
      // Read-only GETs can guide the signed-in owner to the billing explanation;
      // never redirect mutations, as that could hide a failed financial write.
      if(req.method==='GET')return res.redirect(303,'/tenant/billing');
      return res.status(403).send('Subscription unavailable. No changes were made.');
    }
    req.tenant = { ...tenant, id: String(tenant._id), setupStatus: tenant.setupStatus || 'complete' };
    next();
  } catch (e) { next(e); }
};
