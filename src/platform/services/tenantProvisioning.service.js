const { createTenant } = require('../../data/store');
const { tenantDbNameFromSlug } = require('../../config/mongo');
function provisionTenant(payload) {
  const tenant = createTenant(payload);
  return { tenant, database: tenantDbNameFromSlug(tenant.slug), seeded: ['settings','modules','roles','default_branch','notification_templates','receipt_template'] };
}
module.exports = { provisionTenant };
