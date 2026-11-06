const { modules } = require('../../data/store');
const {effectiveSubscription}=require('../../platform/services/commercial.service');
const {effectiveModuleGrant}=require('../../platform/services/moduleSubscriptions.service');
const { permissionsFor } = require('../../config/roles');
function hasPermission(user, permission) {
  const permissions = user?.permissions;
  return Array.isArray(permissions) && (permissions.includes('*') || permissions.includes(permission));
}
function entitled(tenant, moduleKey) {
  const module = modules.find(m => m.key === moduleKey && m.status === 'active' && ['enabled','recording_only'].includes(m.runtimeStatus));
  if (!module || !tenant) return false;
  const plan=effectiveSubscription(tenant);
  return !!((plan && plan.modules.includes(moduleKey) && tenant.enabledModules?.includes(moduleKey)) || effectiveModuleGrant(tenant,moduleKey));
}
function hasModule(tenant,moduleKey){return entitled(tenant,moduleKey);}
function assignableModules(tenant,role){
  const perms=permissionsFor(role);
  return modules.filter(m=>entitled(tenant,m.key) && (perms.includes('*') || m.permissions.some(p=>perms.includes(p)) ||
    (((m.key==='mobile_money' && (perms.includes('mobile_money.review') || (['Reports Analyst','Analytics Analyst'].includes(role) && (perms.includes('reports.view')||perms.includes('analytics.view'))))) || (['money_transfer','banking','forex','approval_workflows','notifications','customers','accounts','expenses'].includes(m.key) && ['Reports Analyst','Analytics Analyst'].includes(role) && (perms.includes('reports.view')||perms.includes('analytics.view'))))))).map(m=>m.key);
}
function validateAssignments(tenant,role,raw){
  const input=raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if(input.length>20 || input.some(x=>typeof x!=='string') || new Set(input).size!==input.length) throw invalid('Invalid module selection');
  const choices=assignableModules(tenant,role);
  if(input.some(x=>!choices.includes(x))) throw invalid('A selected module is unavailable under this plan or role',403);
  return input;
}
function invalid(msg,status=400){const err=new Error(msg);err.status=status;return err;}
function hasModuleForUser(tenant,user,moduleKey){
  if(!entitled(tenant,moduleKey) || !user) return false;
  if(user.role==='Tenant Owner')return true;
  return Array.isArray(user.allowedModules) && user.allowedModules.includes(moduleKey);
}
function canUse(tenant,user,moduleKey,permission){return hasModuleForUser(tenant,user,moduleKey)&&hasPermission(user,permission);}
module.exports={hasModule,hasPermission,hasModuleForUser,assignableModules,validateAssignments,canUse};
