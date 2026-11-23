const { hasPermission } = require('../tenant/services/moduleAccess.service');
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
  const {hasModuleForUser}=require('../tenant/services/moduleAccess.service');
  const can=permission=>hasPermission(user,permission);
  const module=key=>hasModuleForUser(tenant,user,key);
  const item=(label,path,icon='fa-angle-right',extra={})=>({label,href:'/tenant/'+path,icon,...extra});
  const groups=[];
  const group=(label,items,paths=[])=>{if(items.length)groups.push({label,items,paths:paths.map(path=>'/tenant/'+path)});};
  const mobile=module('mobile_money')&&can('mobile_money.view');
  const financialModules=['mobile_money','money_transfer','banking','forex','expenses'];
  const cashReportSource=financialModules.some(module);
  const sharedCash=financialModules.some(key=>module(key)&&can(`${key}.view`))&&can('treasury.view');
  const transfer=module('money_transfer')&&can('money_transfer.view');
  const banking=module('banking')&&can('banking.view');
  const forex=module('forex')&&can('forex.view');
  const reports=module('reports')&&can('reports.view');
  const customers=module('customers')&&can('customers.view');
  const accounts=module('accounts')&&can('accounts.view');
  const expenses=module('expenses')&&can('expenses.view');
  const manualMovements=sharedCash&&['money_transfer','banking','forex'].some(key=>module(key)&&can(`${key}.view`));
  const canCreate=[['mobile_money','mobile_money.cash_in'],['mobile_money','mobile_money.cash_out'],['money_transfer','money_transfer.create'],['banking','banking.requests.create'],['forex','forex.quotes.create'],['customers','customers.create'],['accounts','accounts.manage'],['expenses','expenses.create'],['approval_workflows','approvals.submit']].some(([key,permission])=>module(key)&&can(permission));
  const staff=can('users.manage')||can('users.manage_branch');
  const workspace=can('workspace.view');
  group('Overview',can('dashboard.view')?[item('Today','dashboard','fa-gauge-high')]:[],[
    ...(canCreate?['transactions/new']:[]),...(mobile||transfer?['last-receipt']:[])
  ]);
  group('Daily work',[
    ...(sharedCash?[item('Cash day','cash/shifts','fa-cash-register'),item('Business funds','treasury','fa-wallet')]:[]),
    ...(expenses?[item('Expenses','expenses','fa-receipt')]:[]),
    ...(manualMovements?[item('Movement requests','funded','fa-list-check')]:[]),
    ...(module('approval_workflows')&&can('approvals.view')?[item('Approvals & corrections','approvals','fa-user-check')]:[])
  ]);
  group('Money Transfer',transfer?[
    item('Send money','money-transfer/send','fa-money-bill-transfer',{transactionKind:can('money_transfer.create')?'transfer':null}),
    ...(can('money_transfer.payout')?[item('Payout by PIN','money-transfer/payout','fa-key',{transactionKind:'payout'})]:[]),
    item('Pending payouts','money-transfer/pending-payouts','fa-clock'),
    item('Transfer history','money-transfer/records','fa-list'),
    ...(['Tenant Owner','Branch Manager','Reconciliation Officer','Auditor'].includes(user.role)?[item('Branch transfer balances','money-transfer/branch-balances','fa-scale-balanced')]:[])
  ]:[],transfer?['money-transfer']:[]);
  group('Mobile Money',mobile?[
    item('Cash-in','mobile-money/cash-in','fa-arrow-down',{transactionKind:can('mobile_money.cash_in')?'cash_in':null}),
    item('Cash-out','mobile-money/cash-out','fa-arrow-up',{transactionKind:can('mobile_money.cash_out')?'cash_out':null}),
    item('Network activity','mobile-money/network-activity','fa-tower-broadcast')
  ]:[],mobile?['mobile-money','mobile-money/shifts',...(module('sms_capture')?['sms-capture']:[])]:[]);
  group('Forex Operations',forex?[
    item('Buy forex','forex/buy','fa-arrow-down',{transactionKind:can('forex.quotes.create')?'forex_buy':null}),
    item('Sell forex','forex/sell','fa-arrow-up',{transactionKind:can('forex.quotes.create')?'forex_sell':null}),
    item('Rates','forex/rates','fa-chart-line'),
    item('Forex history','forex/records','fa-list')
  ]:[],forex?['forex']:[]);
  group('Banking Operations',[
    ...(customers?[item('Customers','customers','fa-address-book')]:[]),
    ...(accounts?[item('Customer accounts','accounts','fa-wallet')]:[]),
    ...(banking?[
      item('Deposit','banking/deposit','fa-arrow-down',{transactionKind:can('banking.requests.create')?'banking_deposit':null}),
      item('Withdraw','banking/withdraw','fa-arrow-up',{transactionKind:can('banking.requests.create')?'banking_withdrawal':null}),
      item('Account transfer','banking/transfer','fa-right-left',{transactionKind:can('banking.requests.create')?'banking_transfer':null}),
      item('Banking history','banking/records','fa-list')
    ]:[])
  ],banking?['banking']:[]);
  group('Operation Reports',[
    ...(reports?[item('Reports','reports','fa-file-lines')]:[]),
    ...(module('analytics')&&can('analytics.view')?[item('Analytics','analytics','fa-chart-pie')]:[])
  ],reports?[
    'reports/daily',
    ...(['mobile_money','money_transfer','banking','forex'].some(module)?['reports/transactions']:[]),
    ...(cashReportSource?['reports/opening','reports/closing']:[]),
    ...(module('expenses')?['reports/expenses']:[]),
    ...(module('money_transfer')?['reports/transfer']:[]),
    ...(module('mobile_money')?['reports/mobile']:[]),
    ...(module('banking')?['reports/banking']:[]),
    ...(module('forex')?['reports/forex']:[])
  ]:[]);
  group('Tenant Workspace',[
    ...(workspace?[item('Settings','workspace','fa-gear')]:[]),
    ...(workspace&&can('workspace.manage')&&user.role==='Tenant Owner'&&['mobile_money','money_transfer','banking','forex'].some(module)?[item('Fees & commissions','workspace/pricing','fa-coins')]:[]),
    ...(can('branches.view')?[item('Branches','branches','fa-location-dot')]:[]),
    ...(staff?[item('Staff','users','fa-users')]:[]),
    ...(module('notifications')&&can('notifications.view')?[item('Notifications','notifications','fa-bell')]:[]),
    ...(can('audit.view')?[item('Audit activity','audit','fa-clock-rotate-left')]:[])
  ],[...(can('modules.view')?['modules']:[]),...(can('billing.view')?['billing']:[])]);
  return groups;
}
function tenantNavigationPath(path){
  if(path==='/tenant/day/close')return '/tenant/cash/shifts';
  if(path.startsWith('/tenant/mobile-money/shifts'))return path.replace('/tenant/mobile-money/shifts','/tenant/cash/shifts');
  if(/^\/tenant\/mobile-money(?:\/(?:history|[a-f0-9]{24})(?:\/.*)?)?\/?$/i.test(path))return '/tenant/mobile-money/network-activity';
  if(/^\/tenant\/money-transfer\/contacts(?:\/.*)?$/i.test(path))return '/tenant/money-transfer/send';
  if(/^\/tenant\/money-transfer(?:\/(?:history|[a-f0-9]{24})(?:\/.*)?)?\/?$/i.test(path))return '/tenant/money-transfer/records';
  if(/^\/tenant\/forex(?:\/(?:history|[a-f0-9]{24})(?:\/.*)?)?\/?$/i.test(path))return '/tenant/forex/records';
  if(/^\/tenant\/banking(?:\/(?:accounts|history|[a-f0-9]{24})(?:\/.*)?)?\/?$/i.test(path))return '/tenant/banking/deposit';
  return path;
}
module.exports = { platformMenu, tenantMenu, tenantNavigationPath };
