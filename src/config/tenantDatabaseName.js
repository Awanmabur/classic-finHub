'use strict';
// Safe to import from workers without loading HTTP session/MFA configuration.
// MongoDB database names must be shorter than 64 bytes. The fixed prefix and
// suffix use 21 bytes; ASCII slugs can therefore contain at most 42 characters.
const MAX_SLUG_LENGTH=42;
const NAME=/^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/;
function tenantDbNameFromSlug(slug){
 if(typeof slug!=='string'||!NAME.test(slug))throw new Error('Invalid tenant slug');
 return `classicfin_tenant_${slug.replace(/-/g,'_')}_db`;
}
module.exports={NAME,MAX_SLUG_LENGTH,tenantDbNameFromSlug};
