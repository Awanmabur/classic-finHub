'use strict';
// This policy is enforced in database query predicates as well as before writes.
// A Branch Manager is never a tenant-wide administrator or financial reviewer.
const { INVITABLE, BRANCH_INVITABLE } = require('../../config/roles');
const { hasModuleForUser } = require('./moduleAccess.service');
const OBJECT_ID = /^[a-f0-9]{24}$/i;
function denied(message='This administrator cannot manage the requested staff member') {
  const err = new Error(message); err.status = 403; return err;
}
function canManage(actor) { return actor?.role === 'Tenant Owner' || actor?.role === 'Branch Manager'; }
function managedRoles(actor) {
  if(actor?.role==='Tenant Owner') return INVITABLE;
  if(actor?.role==='Branch Manager' && OBJECT_ID.test(String(actor.branchId||''))) return BRANCH_INVITABLE;
  return [];
}
function staffFilter(actor) {
  if(actor?.role==='Tenant Owner') return {role:{$ne:'Tenant Owner'}};
  if(actor?.role==='Branch Manager' && OBJECT_ID.test(String(actor.branchId||'')))
    return {role:{$in:BRANCH_INVITABLE},branchId:String(actor.branchId)};
  throw denied();
}
function directoryFilter(actor) {
  if(actor?.role==='Tenant Owner') return {};
  if(actor?.role==='Branch Manager' && OBJECT_ID.test(String(actor.branchId||'')))
    return {branchId:String(actor.branchId),role:{$in:BRANCH_INVITABLE}};
  throw denied();
}
function enforceAssignment(tenant,actor,role,branchId,allowedModules) {
  if(!managedRoles(actor).includes(role)) throw denied('This role can only be assigned by the tenant owner');
  if(!OBJECT_ID.test(String(branchId||''))) throw denied('An active branch assignment is required');
  if(actor.role==='Branch Manager') {
    if(String(branchId)!==String(actor.branchId)) throw denied('You can only administer your assigned branch');
    if(allowedModules.some(key=>!hasModuleForUser(tenant,actor,key)))
      throw denied('You cannot grant a module that is not assigned to your own account');
  }
}
module.exports={canManage,managedRoles,staffFilter,directoryFilter,enforceAssignment,denied};
