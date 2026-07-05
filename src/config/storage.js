function tenantPath(tenantId, area) {
  return `/private/tenants/${tenantId}/${area}`;
}
module.exports = { tenantPath };
