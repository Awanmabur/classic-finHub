const { getTenantConnection } = require('../config/mongo');
module.exports = function tenantDb(req, res, next) {
  if (process.env.MOCK_DB === 'true' || !req.tenant) return next();
  req.tenantDb = getTenantConnection(req.tenant.slug);
  next();
};
