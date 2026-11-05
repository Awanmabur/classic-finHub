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
  const allowed = permission => hasPermission(user,permission);
  const entitled = (moduleKey,permission) =>
    require('../tenant/services/moduleAccess.service').hasModuleForUser(tenant,user,moduleKey) && allowed(permission);
  const groups = [];
  const add = (label,items) => { if(items.length) groups.push({label,items}); };
  const item = (label,href,icon) => ({label,href,icon});

  if(allowed('dashboard.view')) add('Overview',[
    item('Today snapshot','/tenant/dashboard','fa-gauge-high')
  ]);

  if(entitled('money_transfer','money_transfer.view')) {
    const items=[item('Transfer requests','/tenant/money-transfer','fa-money-bill-transfer')];
    if(entitled('money_transfer','money_transfer.create'))items.push(item('New transfer request','/tenant/money-transfer?new=request','fa-plus'));
    items.push(item('Sender and receiver contacts','/tenant/money-transfer/contacts','fa-address-book'));
    if(entitled('money_transfer','money_transfer.contacts'))items.push(item('Add contact','/tenant/money-transfer/contacts?new=contact','fa-user-plus'));
    if(entitled('money_transfer','money_transfer.review'))items.push(item('Independent review queue','/tenant/money-transfer','fa-user-shield'));
    items.push(item('Transfer history','/tenant/money-transfer/history','fa-clock-rotate-left'));
    add('Money Transfer',items);
  }

  if(entitled('mobile_money','mobile_money.view')) {
    const items=[item('Network activity','/tenant/mobile-money','fa-mobile-screen-button')];
    if(entitled('mobile_money','mobile_money.cash_in'))items.push(item('Cash-in','/tenant/mobile-money?new=record&operation=cash_in','fa-arrow-down'));
    if(entitled('mobile_money','mobile_money.cash_out'))items.push(item('Cash-out','/tenant/mobile-money?new=record&operation=cash_out','fa-arrow-up'));
    items.push(item('Mobile activity history','/tenant/mobile-money/history','fa-clock-rotate-left'));
    items.push(item('Physical cash shifts','/tenant/mobile-money/shifts','fa-cash-register'));
    if(['Tenant Owner','Mobile Money Operator'].includes(user.role))items.push(item('Request cash shift opening','/tenant/mobile-money/shifts?new=shift','fa-vault'));
    add('Mobile Money',items);
  }

  if(entitled('banking','banking.view')) {
    const items=[item('Banking requests','/tenant/banking','fa-building-columns')];
    if(entitled('banking','banking.requests.create')){
      items.push(item('Deposit request','/tenant/banking?new=request&kind=deposit_request','fa-money-bill-wave'));
      items.push(item('Withdrawal request','/tenant/banking?new=request&kind=withdrawal_request','fa-arrow-up-from-bracket'));
      items.push(item('Account transfer request','/tenant/banking?new=request&kind=transfer_request','fa-right-left'));
    }
    items.push(item('Account references','/tenant/banking/accounts','fa-address-card'));
    if(entitled('banking','banking.accounts.manage'))items.push(item('Add account reference','/tenant/banking/accounts?new=account','fa-plus'));
    items.push(item('Request history','/tenant/banking/history','fa-clock-rotate-left'));
    add('Banking',items);
  }

  if(entitled('forex','forex.view')) {
    const items=[item('Rate board and quotations','/tenant/forex','fa-chart-line')];
    if(entitled('forex','forex.rate_manage'))items.push(item('Propose indicative rate','/tenant/forex?new=rate','fa-chart-simple'));
    if(entitled('forex','forex.quotes.create'))items.push(item('New customer quote','/tenant/forex?new=quote','fa-file-circle-plus'));
    items.push(item('Forex quote history','/tenant/forex/history','fa-clock-rotate-left'));
    add('Forex',items);
  }

  if(entitled('approval_workflows','approvals.view')) add('Approval Workflows',[
    item('Requests and decisions','/tenant/approvals','fa-user-shield')
  ]);

  const reports=[];
  if(entitled('reports','reports.view'))reports.push(item('Operations Reports','/tenant/reports','fa-file-lines'));
  if(entitled('analytics','analytics.view'))reports.push(item('Advanced Analytics','/tenant/analytics','fa-chart-pie'));
  if(allowed('audit.view'))reports.push(item('Audit Trail','/tenant/audit','fa-shield-halved'));
  add('Reports & Analytics',reports);

  const management=[];
  if(allowed('users.manage_branch')) management.push(item('Staff & Roles','/tenant/users','fa-users-gear'));
  if(allowed('branches.view')) management.push(item('Branches','/tenant/branches','fa-code-branch'));
  if(allowed('modules.view'))management.push(item('Modules & Add-ons','/tenant/modules','fa-layer-group'));
  if(allowed('billing.view'))management.push(item('Billing & Plan','/tenant/billing','fa-file-invoice-dollar'));
  if(entitled('notifications','notifications.view'))management.push(item('Notifications','/tenant/notifications','fa-bell'));
  add('Administration',management);

  return groups;
}
module.exports = { platformMenu, tenantMenu };
