'use strict';
const path=require('node:path');
// Safe logical object prefix. A storage provider, tenant-scoped auth and encryption
// must be wired before accepting real customer documents.
function tenantPath(tenantId,area) {
  if(!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/i.test(String(tenantId||'')) ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(area||''))) {
    throw new Error('Invalid storage scope');
  }
  return path.posix.join('/private/tenants',tenantId,area);
}
module.exports={tenantPath};
