const { hasModule, hasPermission } = require('../tenant/services/moduleAccess.service');
function platformMenu(user) {
  if (!user || !user.permissions?.includes('*')) return [];
  return [
    { label: 'Command Center', items: [{ label:'Dashboard', href:'/platform/dashboard', icon:'fa-gauge-high' }] },
    { label: 'Tenant Operations', items: [{ label:'Tenants', href:'/platform/tenants', icon:'fa-building-user' }, { label:'Create Tenant',href:'/platform/tenants/create',icon:'fa-plus' }] },
    { label: 'Product & Billing', items: [{ label:'Plans',href:'/platform/plans',icon:'fa-tags' }, { label:'Subscriptions',href:'/platform/subscriptions',icon:'fa-file-contract' }, {label:'Modules',href:'/platform/modules',icon:'fa-layer-group'}, {label:'Module Requests',href:'/platform/modules/requests',icon:'fa-clipboard-list'}] },
    { label: 'Administration', items: [{label:'Appointments',href:'/platform/appointments',icon:'fa-calendar-check'},{label:'Audit Trail',href:'/platform/audit',icon:'fa-shield-halved'},{label:'Background Operations',href:'/platform/operations/queue',icon:'fa-arrows-rotate'}] }
  ];
}
function tenantMenu(tenant,user) {
  if (!tenant || !user) return [];
  const workspace = [];
  if (hasPermission(user,'dashboard.view')) workspace.push({ label:'Overview', href:'/tenant/dashboard',icon:'fa-gauge-high' });
  if (hasPermission(user,'notifications.view') && require('../tenant/services/moduleAccess.service').hasModuleForUser(tenant,user,'notifications')) workspace.push({label:'Notifications',href:'/tenant/notifications',icon:'fa-bell'});
  if (hasPermission(user,'billing.view')) workspace.push({ label:'Billing & Plan', href:'/tenant/billing', icon:'fa-file-invoice-dollar' });
  if (hasPermission(user,'modules.view')) workspace.push({ label:'Modules',href:'/tenant/modules',icon:'fa-layer-group' });
  const ops = [];
  if (require('../tenant/services/moduleAccess.service').hasModuleForUser(tenant,user,'mobile_money') && hasPermission(user,'mobile_money.view')) {ops.push({ label:'Mobile Money',href:'/tenant/mobile-money',icon:'fa-mobile-screen-button' });ops.push({label:'Cash Shifts',href:'/tenant/mobile-money/shifts',icon:'fa-cash-register'});}
  if (require('../tenant/services/moduleAccess.service').hasModuleForUser(tenant,user,'money_transfer') && hasPermission(user,'money_transfer.view')) ops.push({label:'Money Transfer',href:'/tenant/money-transfer',icon:'fa-money-bill-transfer'});
  if (require('../tenant/services/moduleAccess.service').hasModuleForUser(tenant,user,'banking') && hasPermission(user,'banking.view')) ops.push({label:'Banking',href:'/tenant/banking',icon:'fa-building-columns'});
  if (require('../tenant/services/moduleAccess.service').hasModuleForUser(tenant,user,'forex') && hasPermission(user,'forex.view')) ops.push({label:'Forex',href:'/tenant/forex',icon:'fa-chart-line'});
  if (require('../tenant/services/moduleAccess.service').hasModuleForUser(tenant,user,'approval_workflows') && hasPermission(user,'approvals.view')) ops.push({label:'Approval Workflows',href:'/tenant/approvals',icon:'fa-user-shield'});
  if (hasPermission(user,'users.manage') || hasPermission(user,'users.manage_branch')) workspace.push({ label:'Staff & Roles',href:'/tenant/users',icon:'fa-users-gear' });
  if (hasPermission(user,'branches.view') || hasPermission(user,'*')) workspace.push({ label:'Branches',href:'/tenant/branches',icon:'fa-code-branch' });
  const reports = [];
  if (hasPermission(user,'reports.view') && require('../tenant/services/moduleAccess.service').hasModuleForUser(tenant,user,'reports')) reports.push({label:'Operations Reports',href:'/tenant/reports',icon:'fa-file-lines'});
  if (hasPermission(user,'analytics.view') && require('../tenant/services/moduleAccess.service').hasModuleForUser(tenant,user,'analytics')) reports.push({label:'Advanced Analytics',href:'/tenant/analytics',icon:'fa-chart-pie'});
  if (hasPermission(user,'audit.view')) reports.push({label:'Audit Trail',href:'/tenant/audit',icon:'fa-shield-halved'});
  return [
    { label:'Workspace', items:workspace },
    { label:'Operations',items:ops },
    { label:'Reports & Control',items:reports }
  ].filter(g=>g.items.length);
}
module.exports = { platformMenu, tenantMenu };
