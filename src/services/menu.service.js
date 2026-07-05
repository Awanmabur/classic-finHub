function platformMenu() {
  return [
    { label: 'Command Center', items: [
      { label: 'Dashboard', href: '/platform/dashboard', icon: 'fa-gauge-high' },
      { label: 'Marketplace', href: '/platform/marketplace', icon: 'fa-store' },
      { label: 'Appointments', href: '/platform/appointments', icon: 'fa-calendar-check' }
    ]},
    { label: 'Tenant Operations', items: [
      { label: 'Tenants', href: '/platform/tenants', icon: 'fa-building-user' },
      { label: 'Create Tenant', href: '/platform/tenants/create', icon: 'fa-plus' },
      { label: 'Module Requests', href: '/platform/module-requests', icon: 'fa-code-pull-request' },
      { label: 'Subscriptions', href: '/platform/subscriptions', icon: 'fa-rotate' }
    ]},
    { label: 'Product & Billing', items: [
      { label: 'Modules', href: '/platform/modules', icon: 'fa-layer-group' },
      { label: 'Plans', href: '/platform/plans', icon: 'fa-tags' },
      { label: 'Plan Editor', href: '/platform/plans/editor', icon: 'fa-pen-ruler' },
      { label: 'Invoices', href: '/platform/invoices', icon: 'fa-file-invoice-dollar' },
      { label: 'Payments', href: '/platform/payments', icon: 'fa-credit-card' }
    ]},
    { label: 'Administration', items: [
      { label: 'Platform Users', href: '/platform/users', icon: 'fa-users-gear' },
      { label: 'Audit Logs', href: '/platform/audit-logs', icon: 'fa-clipboard-list' },
      { label: 'Settings', href: '/platform/settings', icon: 'fa-gear' }
    ]}
  ];
}

function tenantMenu(tenant, user = {}) {
  const enabled = tenant?.enabledModules || [];
  const permissions = user.permissions || ['*'];
  const can = (moduleKey, permission) => enabled.includes(moduleKey) && (permissions.includes('*') || permissions.includes(permission));
  const suspended = tenant?.status === 'suspended';
  if (suspended) {
    return [{ label: 'Restricted Access', items: [
      { label: 'Billing', href: '/tenant/billing', icon: 'fa-file-invoice-dollar' },
      { label: 'Support', href: '/support', icon: 'fa-headset' }
    ]}];
  }
  const operationItems = [];
  if (can('money_transfer','money_transfer.view')) operationItems.push({ label: 'Money Transfer', href: '/tenant/money-transfer', icon: 'fa-money-bill-transfer' });
  if (can('mobile_money','mobile_money.view')) operationItems.push({ label: 'Mobile Money', href: '/tenant/mobile-money', icon: 'fa-mobile-screen-button' });
  if (can('banking','banking.view')) operationItems.push({ label: 'Banking', href: '/tenant/banking', icon: 'fa-building-columns' });
  if (can('forex','forex.view')) operationItems.push({ label: 'Forex', href: '/tenant/forex', icon: 'fa-chart-line' });
  return [
    { label: 'Workspace', items: [
      { label: 'Overview', href: '/tenant/dashboard', icon: 'fa-gauge-high' },
      { label: 'Setup Wizard', href: '/tenant/setup', icon: 'fa-list-check' },
      { label: 'Marketplace', href: '/tenant/marketplace', icon: 'fa-store' },
      { label: 'Modules', href: '/tenant/modules', icon: 'fa-layer-group' }
    ]},
    { label: 'Operations', items: operationItems },
    { label: 'Customers & Staff', items: [
      { label: 'Customers', href: '/tenant/customers', icon: 'fa-address-book' },
      { label: 'Accounts', href: '/tenant/accounts', icon: 'fa-wallet' },
      { label: 'Branches', href: '/tenant/branches', icon: 'fa-code-branch' },
      { label: 'Users', href: '/tenant/users', icon: 'fa-users' },
      { label: 'Roles', href: '/tenant/roles', icon: 'fa-user-shield' }
    ]},
    { label: 'Reports & Control', items: [
      { label: 'Reports', href: '/tenant/reports', icon: 'fa-file-lines' },
      { label: 'Analytics', href: '/tenant/analytics', icon: 'fa-chart-pie' },
      { label: 'Expenses', href: '/tenant/expenses', icon: 'fa-receipt' },
      { label: 'Notifications', href: '/tenant/notifications', icon: 'fa-bell' },
      { label: 'Receipts', href: '/tenant/receipts', icon: 'fa-print' },
      { label: 'Billing', href: '/tenant/billing', icon: 'fa-file-invoice-dollar' }
    ]},
    { label: 'Tenant Admin', items: [
      { label: 'Landing Page', href: '/tenant/landing-page', icon: 'fa-window-maximize' },
      { label: 'Audit Logs', href: '/tenant/audit-logs', icon: 'fa-clipboard-list' },
      { label: 'Settings', href: '/tenant/settings', icon: 'fa-gear' }
    ]}
  ].filter(group => group.items.length);
}

module.exports = { platformMenu, tenantMenu };
