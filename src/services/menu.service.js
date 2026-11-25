const { hasPermission } = require('../tenant/services/moduleAccess.service');
function platformMenu(user) {
  if (!user || !user.permissions?.includes('*')) return [];
  return [
    { label: 'Command Center', items: [{ label:'Dashboard', href:'/platform/dashboard', icon:'fa-gauge-high' }] },
    { label: 'Tenant Operations', items: [{ label:'Tenants', href:'/platform/tenants', icon:'fa-building-user' }, { label:'Create Tenant',href:'/platform/tenants/create',icon:'fa-plus' }] },
    { label: 'Product & Billing', items: [{ label:'Plans',href:'/platform/plans',icon:'fa-tags' }, { label:'Subscriptions',href:'/platform/subscriptions',icon:'fa-file-contract' }, {label:'Modules',href:'/platform/modules',icon:'fa-layer-group'}, {label:'Module Requests',href:'/platform/modules/requests',icon:'fa-clipboard-list'}] },
    { label: 'Administration', items: [{label:'Appointments',href:'/platform/appointments',icon:'fa-calendar-check'},{label:'Customer reviews',href:'/platform/business-reviews',icon:'fa-star'},{label:'Audit Trail',href:'/platform/audit',icon:'fa-shield-halved'},{label:'Background Operations',href:'/platform/operations/queue',icon:'fa-arrows-rotate'}] }
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
  const cashModules=['mobile_money','money_transfer','banking','forex','expenses'];
  const financialModules=[...cashModules,'loans','airtime'];
  const cashReportSource=financialModules.some(module);
  const sharedCash=financialModules.some(key=>module(key)&&can(`${key}.view`))&&can('treasury.view');
  const cashDay=sharedCash&&cashModules.some(module)&&['Tenant Owner','Branch Manager','Reconciliation Officer','Auditor','Mobile Money Operator','Money Transfer Operator','Banking Operator','Forex Operator'].includes(user.role);
  const transfer=module('money_transfer')&&can('money_transfer.view');
  const banking=module('banking')&&can('banking.view');
  const forex=module('forex')&&can('forex.view');
  const reports=module('reports')&&can('reports.view');
  const customers=module('customers')&&can('customers.view');
  const accounts=module('accounts')&&can('accounts.view');
  const expenses=module('expenses')&&can('expenses.view');
  const manualMovements=sharedCash&&['money_transfer','banking','forex'].some(key=>module(key)&&can(`${key}.view`));
  const canCreate=[['mobile_money','mobile_money.cash_in'],['mobile_money','mobile_money.cash_out'],['money_transfer','money_transfer.create'],['banking','banking.requests.create'],['forex','forex.quotes.create'],['customers','customers.create'],['accounts','accounts.manage'],['expenses','expenses.create'],['approval_workflows','approvals.submit'],['loans','loans.create'],['airtime','airtime.sell']].some(([key,permission])=>module(key)&&can(permission));
  const staff=can('users.manage')||can('users.manage_branch');
  const workspace=can('workspace.view');
  const owner=user.role==='Tenant Owner';
  group('Overview',can('dashboard.view')?[item('Today','dashboard','fa-gauge-high')]:[],[
    ...(canCreate?['transactions/new']:[]),...(mobile||transfer?['last-receipt']:[])
  ]);
  group('Daily work',[
    ...(cashDay?[item('Cash day','cash/shifts','fa-cash-register')]:[]),
    ...(sharedCash?[item(owner?'Money accounts':'Business funds','treasury','fa-wallet')]:[]),
    ...(expenses?[item('Expenses','expenses','fa-receipt')]:[]),
    ...(!owner&&manualMovements?[item('Movement requests','funded','fa-list-check')]:[]),
    ...(!owner&&module('approval_workflows')&&can('approvals.view')?[item('Approvals & corrections','approvals','fa-user-check')]:[])
  ]);
  group('Money Transfer',transfer?[
    ...(can('money_transfer.create')?[item('Send money','money-transfer/send','fa-money-bill-transfer',{transactionKind:'transfer'})]:[]),
    ...(can('money_transfer.payout')?[item('Payout by PIN','funded/payout','fa-key',{transactionKind:'payout'})]:[]),
    item('Pending payouts','money-transfer/pending-payouts','fa-clock'),
    item('Transfer history','money-transfer/records','fa-list'),
    ...(['Tenant Owner','Branch Manager','Reconciliation Officer','Auditor'].includes(user.role)?[item('Branch transfer balances','money-transfer/branch-balances','fa-scale-balanced')]:[])
  ]:[],transfer?['money-transfer']:[]);
  group('Mobile Money',mobile?[
    ...(can('mobile_money.cash_in')?[item('Deposit','mobile-money/cash-in','fa-arrow-down',{transactionKind:'cash_in'})]:[]),
    ...(can('mobile_money.cash_out')?[item('Withdrawal','mobile-money/cash-out','fa-arrow-up',{transactionKind:'cash_out'})]:[]),
    item('Network activity','mobile-money/network-activity','fa-tower-broadcast')
  ]:[],mobile?['mobile-money','mobile-money/shifts',...(module('sms_capture')?['sms-capture']:[])]:[]);
  const loanAccess=module('loans')&&can('loans.view');
  const airtimeAccess=module('airtime')&&can('airtime.view');
  group('Loan Management',loanAccess?[item('Loan portfolio','loans','fa-hand-holding-dollar'),
    ...(can('loans.create')?[item('Loan applications','loans#loan-applications','fa-file-signature')]:[]),item('Loan Management report','loans/report','fa-chart-column')]:[],loanAccess?['loans']:[]);
  group('Airtime',airtimeAccess?[item('Airtime sales & stock','airtime','fa-sim-card'),item('Airtime report','airtime/report','fa-chart-column')]:[],airtimeAccess?['airtime']:[]);
  group('Forex Operations',forex?[
    ...(can('forex.quotes.create')?[
      item('Buy forex','forex/buy','fa-arrow-down',{transactionKind:'forex_buy'}),
      item('Sell forex','forex/sell','fa-arrow-up',{transactionKind:'forex_sell'})
    ]:[]),
    item('Rates','forex/rates','fa-chart-line'),
    item('Forex history','forex/records','fa-list')
  ]:[],forex?['forex']:[]);
  group('Banking Operations',[
    ...(customers?[item('Customers','customers','fa-address-book')]:[]),
    ...(accounts?[item('Customer accounts','accounts','fa-wallet')]:[]),
    ...(banking&&can('banking.requests.create')?[
      item('Deposit','banking/deposit','fa-arrow-down',{transactionKind:'banking_deposit'}),
      item('Withdraw','banking/withdraw','fa-arrow-up',{transactionKind:'banking_withdrawal'}),
      item('Account transfer','banking/transfer','fa-right-left',{transactionKind:'banking_transfer'})
    ]:[]),
    ...(banking?[item('Banking history','banking/records','fa-list')]:[])
  ],banking?['banking']:[]);
  group('Operation Reports',[
    ...(reports?[item('General reports','reports','fa-file-lines')]:[]),
    ...(module('analytics')&&can('analytics.view')?[item('Analytics','analytics','fa-chart-pie')]:[])
  ],reports?[
    ...(owner?['reports/summary']:[]),
    'reports/daily',
    ...(['mobile_money','money_transfer','banking','forex'].some(module)?['reports/transactions']:[]),
    ...(cashReportSource?['reports/opening','reports/closing']:[]),
    ...(module('expenses')?['reports/expenses']:[]),
    ...(module('money_transfer')?['reports/transfer']:[]),
    ...(module('mobile_money')?['reports/mobile']:[]),
    ...(module('banking')?['reports/banking']:[]),
    ...(module('forex')?['reports/forex']:[]),
    ...(loanAccess?['reports/loans']:[]),
    ...(airtimeAccess?['reports/airtime']:[])
  ]:[]);
  group('Tenant Workspace',[
    ...(user.role==='Tenant Owner'?[item('Quick setup','setup','fa-wand-magic-sparkles')]:[]),
    ...(workspace?[item('Settings','workspace','fa-gear'),item('Business website','workspace/landing','fa-globe'),
      item('Customer reviews','workspace/reviews','fa-star')]:[]),
    ...(user.role==='Tenant Owner'&&can('modules.view')?[item('Request modules','modules','fa-layer-group')]:[]),
    ...(workspace&&can('workspace.manage')&&user.role==='Tenant Owner'&&['mobile_money','money_transfer','banking','forex'].some(module)?[item('Fees & commissions','workspace/pricing','fa-coins')]:[]),
    ...(can('branches.view')?[item('Branches','branches','fa-location-dot')]:[]),
    ...(staff?[item('Staff','users','fa-users')]:[]),
    ...(module('notifications')&&can('notifications.view')?[item('Notifications','notifications','fa-bell')]:[]),
    ...(can('audit.view')?[item('Audit activity','audit','fa-clock-rotate-left')]:[])
  ],[...(can('modules.view')?['modules']:[]),...(can('billing.view')?['billing']:[])]);
  return groups;
}
function tenantNavigationPath(path){
  if(/^\/tenant\/mobile-money\/fx(?:\/.*)?$/.test(path))return '/tenant/mobile-money/cash-out';
  if(path==='/tenant/day/close')return '/tenant/cash/shifts';
  if(path.startsWith('/tenant/mobile-money/shifts'))return path.replace('/tenant/mobile-money/shifts','/tenant/cash/shifts');
  if(/^\/tenant\/mobile-money(?:\/(?:history|[a-f0-9]{24})(?:\/.*)?)?\/?$/i.test(path))return '/tenant/mobile-money/network-activity';
  if(/^\/tenant\/money-transfer\/contacts(?:\/.*)?$/i.test(path))return '/tenant/money-transfer/send';
  if(/^\/tenant\/money-transfer(?:\/(?:history|[a-f0-9]{24})(?:\/.*)?)?\/?$/i.test(path))return '/tenant/money-transfer/records';
  if(/^\/tenant\/forex(?:\/(?:history|[a-f0-9]{24})(?:\/.*)?)?\/?$/i.test(path))return '/tenant/forex/records';
  if(/^\/tenant\/banking(?:\/(?:accounts|history|[a-f0-9]{24})(?:\/.*)?)?\/?$/i.test(path))return '/tenant/banking/records';
  return path;
}
module.exports = { platformMenu, tenantMenu, tenantNavigationPath };
