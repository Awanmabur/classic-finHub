const { tenants } = require('../data/store');
module.exports = function tenantResolver(req, res, next) {
  const slug = req.params.slug || req.headers['x-tenant-slug'] || req.query.tenant || 'acme';
  req.tenant = tenants.find((tenant) => tenant.slug === slug) || tenants[0];
  next();
};
