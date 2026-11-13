'use strict';
// Safe to import from workers without loading HTTP session/MFA configuration.
// MongoDB's general 63-byte database-name limit is higher than the 38-byte
// limit on the production Atlas Free (M0) cluster. Limit new tenant slugs to
// 17 ASCII characters (21-byte prefix/suffix + 17 = 38). Preserve the wider
// NAME validator for existing tenants and scratch DBs created on other tiers.
const MAX_SLUG_LENGTH=17;
const NAME=/^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/;
function tenantDbNameFromSlug(slug){
 if(typeof slug!=='string'||!NAME.test(slug))throw new Error('Invalid tenant slug');
 return `classicfin_tenant_${slug.replace(/-/g,'_')}_db`;
}
module.exports={NAME,MAX_SLUG_LENGTH,tenantDbNameFromSlug};
