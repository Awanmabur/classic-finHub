function hasModule(tenant, moduleKey) { return tenant?.enabledModules?.includes(moduleKey); }
function hasPermission(user, permission) { return user?.permissions?.includes('*') || user?.permissions?.includes(permission); }
function canUse(tenant, user, moduleKey, permission) { return hasModule(tenant, moduleKey) && hasPermission(user, permission); }
module.exports = { hasModule, hasPermission, canUse };
