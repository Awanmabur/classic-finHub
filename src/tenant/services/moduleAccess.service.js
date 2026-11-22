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
  return modules.filter(m=>entitled(tenant,m.key) && ((m.key==='mobile_money'&&perms.includes('treasury.view')&&['Money Transfer Operator','Banking Operator','Forex Operator'].includes(role))||perms.includes('*') || m.permissions.some(p=>perms.includes(p)) ||
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

// A module assignment is not a role escalation. Distinguish actionable access,
// viewing and report-source assignment so administrators can fix actual blockers.
const ENTRY_PATH=Object.freeze({
 mobile_money:'/tenant/mobile-money',money_transfer:'/tenant/money-transfer',
 banking:'/tenant/banking',forex:'/tenant/forex',accounts:'/tenant/accounts',
 customers:'/tenant/customers',expenses:'/tenant/expenses',reports:'/tenant/reports',
 analytics:'/tenant/analytics',notifications:'/tenant/notifications',
 approval_workflows:'/tenant/approvals',loans:'/tenant/loans',airtime:'/tenant/airtime',
 sms_capture:'/tenant/sms-capture'
});
const VIEW_PERMISSION=Object.freeze({approval_workflows:'approvals.view',sms_capture:'mobile_money.cash_in'});
function moduleAccessState(tenant,user,key){
 const subscribed=entitled(tenant,key);
 const assigned=subscribed&&hasModuleForUser(tenant,user,key);
 const module=modules.find(m=>m.key===key);
 if(!subscribed)return {state:'unsubscribed',message:'Not subscribed or subscription expired',href:null};
 if(!assigned)return {state:'not-assigned',message:'Subscribed but not assigned to this staff account',href:null};
 const view=VIEW_PERMISSION[key]||key+'.view';
 const canOpen=hasPermission(user,view);
 const actions=(module?.permissions||[]).filter(p=>!p.endsWith('.view')&&!p.endsWith('.export')&&!p.endsWith('.report')&&!p.endsWith('.logs')&&hasPermission(user,p));
 if(canOpen&&actions.length)return {state:'operate',message:'Assigned · operations permitted by role',href:ENTRY_PATH[key]||null,actions};
 if(canOpen)return {state:'view-only',message:'Assigned · view-only for this role',href:ENTRY_PATH[key]||null,actions:[]};
 if(['Reports Analyst','Analytics Analyst'].includes(user.role)&&
    (hasPermission(user,'reports.view')||hasPermission(user,'analytics.view')))
  return {state:'report-source',message:'Assigned as reporting data only; transaction access is not part of this role',href:hasModuleForUser(tenant,user,'reports')&&hasPermission(user,'reports.view')?'/tenant/reports':hasModuleForUser(tenant,user,'analytics')&&hasPermission(user,'analytics.view')?'/tenant/analytics':null,actions:[]};
 return {state:'role-blocked',message:'Assigned, but the selected staff role has no entry permission for this module',href:null,actions:[]};
}
module.exports={hasModule,hasPermission,hasModuleForUser,assignableModules,validateAssignments,canUse,moduleAccessState};
