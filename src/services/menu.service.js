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
  const {hasModuleForUser}=require('../tenant/services/moduleAccess.service');
  const can=permission=>hasPermission(user,permission);
  const module=key=>hasModuleForUser(tenant,user,key);
  const item=(label,path,icon='fa-angle-right',extra={})=>({label,href:'/tenant/'+path,icon,...extra});
  const groups=[];
  const group=(label,items,paths=[])=>{if(items.length)groups.push({label,items,paths:paths.map(path=>'/tenant/'+path)});};
  const mobile=module('mobile_money')&&can('mobile_money.view');
  const sharedCash=['mobile_money','money_transfer','banking','forex','expenses'].some(module);
  const transfer=module('money_transfer')&&can('money_transfer.view');
  const banking=module('banking')&&can('banking.view');
  const forex=module('forex')&&can('forex.view');
  const reports=module('reports')&&can('reports.view');
  const customers=module('customers')&&can('customers.view');
  const accounts=module('accounts')&&can('accounts.view');
  const expenses=module('expenses')&&can('expenses.view');
  const staff=can('users.manage')||can('users.manage_branch');
  const workspace=can('workspace.view');
  group('Overview',can('dashboard.view')?[
    item('Today snapshot','dashboard','fa-gauge-high'),
    item('New transaction','transactions/new','fa-plus',{'transactionKind':'choose'}),
    item('Last receipt','last-receipt','fa-receipt')
  ]:[]);
  group('Money Transfer',transfer?[
    item('Send money / Generate PIN','money-transfer/send','fa-money-bill-transfer',{transactionKind:can('money_transfer.create')?'transfer':null}),
    item('Payout by PIN','money-transfer/payout','fa-key'),
    item('Pending payout queue','money-transfer/pending-payouts','fa-clock'),
    item('Money transfer record','money-transfer/records','fa-list'),
    item('Transfer fee summary','money-transfer/fees','fa-coins'),
    item('Transfer report summary','money-transfer/report','fa-file-lines')
  ]:[],transfer?['money-transfer']:[]);
  group('Mobile Money',mobile?[
    item('Cash-in','mobile-money/cash-in','fa-arrow-down',{transactionKind:can('mobile_money.cash_in')?'cash_in':null}),
    item('Cash-out','mobile-money/cash-out','fa-arrow-up',{transactionKind:can('mobile_money.cash_out')?'cash_out':null}),
    item('Network activity','mobile-money/network-activity','fa-tower-broadcast'),
    item('Cash impact','mobile-money/cash-impact','fa-cash-register'),
    ...(can('mobile_money.report')||can('reports.view')?[item('Mobile money report','mobile-money/report','fa-file-lines')]:[])
  ]:[],mobile?['mobile-money','mobile-money/shifts',...(module('sms_capture')?['sms-capture']:[])]:[]);
  group('Forex Operations',forex?[
    item('Buy forex from customer','forex/buy','fa-arrow-down',{transactionKind:can('forex.quotes.create')?'forex_buy':null}),
    item('Sell forex to customer','forex/sell','fa-arrow-up',{transactionKind:can('forex.quotes.create')?'forex_sell':null}),
    item('Active rate board','forex/rates','fa-chart-line'),
    item('Forex cash impact','forex/cash-impact','fa-cash-register'),
    item('Forex operation records','forex/records','fa-list'),
    item('Forex report summary','forex/report','fa-file-lines')
  ]:[],forex?['forex']:[]);
  group('Banking Operations',[
    ...(customers?[item('Customers directory','customers','fa-address-book'),...(can('customers.create')?[item('New customer','customers/new','fa-user-plus',{transactionKind:'customer'})]:[]),item('Customer logbook','customers/logbook','fa-book')]:[]),
    ...(accounts?[item('Accounts directory','accounts','fa-wallet'),...(can('accounts.manage')?[item('New account','accounts/new','fa-plus',{transactionKind:'account'})]:[])]:[]),
    ...(banking?[item('Deposit','banking/deposit','fa-arrow-down',{transactionKind:can('banking.requests.create')?'banking_deposit':null}),item('Withdraw','banking/withdraw','fa-arrow-up',{transactionKind:can('banking.requests.create')?'banking_withdrawal':null}),item('Account transfer','banking/transfer','fa-right-left',{transactionKind:can('banking.requests.create')?'banking_transfer':null})]:[]),
    ...(accounts?[item('Account balances','accounts/balances','fa-scale-balanced'),item('Account movements','accounts/movements','fa-list')]:[]),
    ...(banking?[item('Banking report summary','banking/report','fa-file-lines')]:[])
  ],banking?['banking']:[]);
  group('Operation Reports',[
    ...(reports?[item('Daily business report','reports/daily','fa-chart-simple')]:[]),
    ...(sharedCash&&['Tenant Owner','Mobile Money Operator','Money Transfer Operator','Banking Operator','Forex Operator'].includes(user.role)?[item('Open day','cash/shifts','fa-unlock',{transactionKind:'cash_shift_open'}),item('Close day','day/close','fa-lock',{transactionKind:'cash_shift_close'})]:[]),
    ...(expenses&&can('expenses.create')?[item('Add expense','expenses/new','fa-money-bill',{transactionKind:'expense'})]:[]),
    ...(reports&&can('reports.export')?[item('Export CSV','reports/export.csv','fa-download')]:[]),
    ...(reports?[item('Print report','reports/print','fa-print'),item('General reports page','reports','fa-file-lines'),item('Opening cash report','reports/opening','fa-unlock'),item('Closing cash / expected cash','reports/closing','fa-lock'),item('Transaction summary','reports/transactions','fa-list'),item('Expenses report','reports/expenses','fa-receipt'),item('Transfer report','reports/transfer','fa-money-bill-transfer'),item('Mobile report','reports/mobile','fa-mobile-screen-button'),item('Banking report','reports/banking','fa-building-columns')]:[])
  ],[...(reports?['reports']:[]),...(expenses?['expenses']:[]),...(sharedCash?['cash/shifts']:[])]);
  group('Tenant Workspace',[
    ...(workspace?[item('Tenant profile','workspace/profile','fa-building'),item('Landing page setup','workspace/landing','fa-window-maximize'),item('Branding & receipts','workspace/branding','fa-palette')]:[]),
    ...(can('branches.view')?[item('Branches & locations','branches','fa-location-dot')]:[]),
    ...(staff?[item('Admins, tellers & users','users','fa-users')]:[]),
    ...(workspace?[item('Roles & permissions','workspace/roles','fa-user-shield'),item('Customer/KYC setup','workspace/kyc','fa-id-card'),item('Tenant database','workspace/database','fa-database'),item('Subscription & limits','workspace/subscription','fa-file-contract'),item('Notification rules','workspace/notification-rules','fa-bell'),item('Integrations & API','workspace/integrations','fa-plug'),item('Import / export data','workspace/import-export','fa-file-export'),item('Compliance controls','workspace/compliance','fa-shield-halved'),item('Landing preview','workspace/landing-preview','fa-globe'),item('Receipt preview','workspace/receipt-preview','fa-receipt'),item('Customer portal preview','workspace/customer-portal-preview','fa-users-viewfinder')]:[]),
    ...(can('audit.view')?[item('Tenant audit activity','audit','fa-clock-rotate-left')]:[])
  ],[...(can('modules.view')?['modules']:[]),...(can('billing.view')?['billing']:[]),...(workspace?['workspace']:[])]);
  group('Phase 2 Control',[
    ...(module('notifications')&&can('notifications.view')?[item('Notifications center','notifications','fa-bell')]:[]),
    ...(module('analytics')&&can('analytics.view')?[item(user.role==='Tenant Owner'?'Remote owner dashboard':'Advanced Analytics','analytics','fa-chart-pie')]:user.role==='Tenant Owner'?[item('Remote owner dashboard','workspace/control','fa-chart-pie')]:[]),
    ...(staff?[item('Teller & staff users','users','fa-users')]:[]),
    ...(can('audit.view')?[item('Logs and audit trail','audit','fa-shield-halved')]:[]),
    ...(module('approval_workflows')&&can('approvals.view')?[item('Approvals & corrections','approvals','fa-user-check')]:[]),
    ...(sharedCash&&['Tenant Owner','Branch Manager','Reconciliation Officer','Auditor'].includes(user.role)?[item('Cash control review','cash/shifts','fa-cash-register')]:[]),
    ...(workspace?[item('Security & roles','workspace/roles','fa-user-shield'),item('System settings','workspace','fa-gear')]:[])
  ],[...(module('analytics')&&can('analytics.view')?['analytics']:[]),...(module('approval_workflows')&&can('approvals.view')?['approvals']:[])]);
  return groups;
}
function tenantNavigationPath(path){
  if(path.startsWith('/tenant/mobile-money/shifts'))return path.replace('/tenant/mobile-money/shifts','/tenant/cash/shifts');
  if(/^\/tenant\/mobile-money(?:\/(?:history|[a-f0-9]{24})(?:\/.*)?)?\/?$/i.test(path))return '/tenant/mobile-money/network-activity';
  if(/^\/tenant\/money-transfer\/contacts(?:\/.*)?$/i.test(path))return '/tenant/money-transfer/send';
  if(/^\/tenant\/money-transfer(?:\/(?:history|[a-f0-9]{24})(?:\/.*)?)?\/?$/i.test(path))return '/tenant/money-transfer/records';
  if(/^\/tenant\/forex(?:\/(?:history|[a-f0-9]{24})(?:\/.*)?)?\/?$/i.test(path))return '/tenant/forex/records';
  if(/^\/tenant\/banking(?:\/(?:accounts|history|[a-f0-9]{24})(?:\/.*)?)?\/?$/i.test(path))return '/tenant/banking/deposit';
  return path;
}
module.exports = { platformMenu, tenantMenu, tenantNavigationPath };
