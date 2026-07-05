const { randomUUID } = require('crypto');

const now = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;

const modules = [
  { key: 'money_transfer', name: 'Money Transfer', category: 'Core Operations', icon: 'fa-money-bill-transfer', status: 'active', isCore: true, priceMonthly: 89, description: 'Send money, generate claim/PIN codes, payout by PIN, receipts, reports, and analytics.', permissions: ['money_transfer.view','money_transfer.create','money_transfer.payout','money_transfer.report'] },
  { key: 'mobile_money', name: 'Mobile Money', category: 'Core Operations', icon: 'fa-mobile-screen-button', status: 'active', isCore: true, priceMonthly: 79, description: 'Cash-in, cash-out, agent float, network activity, reconciliation, receipts, and network reports.', permissions: ['mobile_money.view','mobile_money.cash_in','mobile_money.cash_out','mobile_money.report'] },
  { key: 'banking', name: 'Banking', category: 'Core Operations', icon: 'fa-building-columns', status: 'active', isCore: true, priceMonthly: 129, description: 'Customer accounts, deposits, withdrawals, transfers, ledger entries, statements, and banking analytics.', permissions: ['banking.view','banking.deposit','banking.withdraw','banking.statement'] },
  { key: 'forex', name: 'Forex', category: 'Core Operations', icon: 'fa-chart-line', status: 'active', isCore: true, priceMonthly: 119, description: 'Buy/sell currencies, rate boards, rate approval, forex stock, receipts, and profit/loss by pair.', permissions: ['forex.view','forex.buy','forex.sell','forex.rate_manage','forex.report'] },
  { key: 'analytics', name: 'Advanced Analytics', category: 'Addon', icon: 'fa-chart-pie', status: 'active', isCore: false, priceMonthly: 49, description: 'Profit/loss, branch, operator, module, network, currency-pair comparisons, and export dashboards.', permissions: ['analytics.view','analytics.export'] },
  { key: 'notifications', name: 'Notifications', category: 'Addon', icon: 'fa-bell', status: 'active', isCore: false, priceMonthly: 39, description: 'SMS, email, in-app templates, event triggers, delivery logs, retries, and notification reports.', permissions: ['notifications.view','notifications.manage_templates','notifications.logs'] },
  { key: 'approval_workflows', name: 'Approval Workflows', category: 'Addon', icon: 'fa-user-shield', status: 'active', isCore: false, priceMonthly: 59, description: 'Require approvals for reversals, rate changes, high withdrawals, day close discrepancies, and billing changes.', permissions: ['approvals.view','approvals.decide'] },
  { key: 'customer_portal', name: 'Customer Portal', category: 'Addon', icon: 'fa-users-viewfinder', status: 'active', isCore: false, priceMonthly: 69, description: 'Let customers self-register, view receipts, update profiles, and receive tenant-specific notices.', permissions: ['customer_portal.view','customer_portal.manage'] }
];

const plans = [
  { code: 'starter_trial', name: 'Starter Trial', priceMonthly: 0, priceYearly: 0, currency: 'USD', trialMonths: 2, modules: ['customers','receipts','reports'], limits: { users: 3, branches: 1, transactionsPerMonth: 150, smsPerMonth: 50, storageMb: 500 }, description: 'Trial workspace for demos, users, roles, customers, receipts, and basic reports.' },
  { code: 'agent', name: 'Agent Plan', priceMonthly: 149, priceYearly: 1490, currency: 'USD', trialMonths: 1, modules: ['money_transfer','mobile_money','notifications'], limits: { users: 12, branches: 3, transactionsPerMonth: 5000, smsPerMonth: 1000, storageMb: 3000 }, description: 'Best for agents focused on money transfer and mobile money services.' },
  { code: 'finance', name: 'Finance Plan', priceMonthly: 249, priceYearly: 2490, currency: 'USD', trialMonths: 1, modules: ['banking','forex','analytics'], limits: { users: 25, branches: 6, transactionsPerMonth: 10000, smsPerMonth: 2000, storageMb: 8000 }, description: 'Best for finance teams that need banking, forex, analytics, accounts, and reports.' },
  { code: 'enterprise', name: 'Enterprise Plan', priceMonthly: 499, priceYearly: 4990, currency: 'USD', trialMonths: 2, modules: modules.map(m => m.key), limits: { users: 100, branches: 40, transactionsPerMonth: 100000, smsPerMonth: 20000, storageMb: 50000 }, description: 'All modules, addons, approval workflows, custom domain, API access, audit logs, and multi-branch operations.' }
];

const tenants = [
  { id: 'ten_acme', name: 'Acme Forex & Transfers', slug: 'acme', dbName: 'classicfin_tenant_acme_db', owner: 'Amina Finance', phone: '+256 700 000 111', email: 'owner@acme.test', plan: 'enterprise', status: 'trial', setupStatus: 'complete', trialEndsAt: '2026-08-27', branches: 4, enabledModules: ['money_transfer','mobile_money','banking','forex','analytics','notifications','approval_workflows'] },
  { id: 'ten_nile', name: 'Nile Agent Services', slug: 'nile-agent', dbName: 'classicfin_tenant_nile_agent_db', owner: 'Deng Mawien', phone: '+211 920 000 222', email: 'owner@nile.test', plan: 'agent', status: 'active', setupStatus: 'complete', trialEndsAt: null, branches: 2, enabledModules: ['money_transfer','mobile_money','notifications'] },
  { id: 'ten_kla', name: 'Kampala Trust Finance', slug: 'kampala-trust', dbName: 'classicfin_tenant_kampala_trust_db', owner: 'Classic Operator', phone: '+256 777 000 333', email: 'admin@ktrust.test', plan: 'finance', status: 'suspended', setupStatus: 'complete', trialEndsAt: null, branches: 5, enabledModules: ['banking','forex','analytics'] }
];

const appointments = [
  { id: 'apt_101', businessName: 'Lake Region Forex', contactName: 'Paul Okello', email: 'paul@example.com', phone: '+256 701 222 333', modules: ['forex','banking'], preferredDate: '2026-07-01', status: 'pending', meetingLink: '', notes: 'Interested in rate board and cash drawer controls.', createdAt: now() },
  { id: 'apt_102', businessName: 'South Sudan Transfer Desk', contactName: 'Awan Mabur', email: 'awan@example.com', phone: '+211 920 345 678', modules: ['money_transfer','mobile_money'], preferredDate: '2026-07-03', status: 'confirmed', meetingLink: 'https://meet.example.com/classicfin-demo', notes: 'Needs tenant demo and two-month trial.', createdAt: now() }
];

const moduleRequests = [
  { id: 'mr_200', tenantId: 'ten_nile', tenantName: 'Nile Agent Services', moduleKey: 'analytics', moduleName: 'Advanced Analytics', requestedBy: 'Deng Mawien', reason: 'Need branch and operator profit comparison.', status: 'pending', requestedAt: now(), platformAdminNote: '' }
];

const invoices = [
  { id: 'inv_300', number: 'INV-2026-0001', tenantName: 'Nile Agent Services', amount: 149, currency: 'USD', status: 'paid', dueDate: '2026-07-05', plan: 'Agent Plan' },
  { id: 'inv_301', number: 'INV-2026-0002', tenantName: 'Kampala Trust Finance', amount: 249, currency: 'USD', status: 'overdue', dueDate: '2026-06-20', plan: 'Finance Plan' }
];

const payments = [
  { id: 'pay_401', invoice: 'INV-2026-0001', tenantName: 'Nile Agent Services', amount: 149, currency: 'USD', method: 'Mobile Money', status: 'success', paidAt: now() },
  { id: 'pay_402', invoice: 'INV-2026-0002', tenantName: 'Kampala Trust Finance', amount: 0, currency: 'USD', method: 'Pending', status: 'failed', paidAt: null }
];

const tenantState = {
  currentTenantId: 'ten_acme',
  branches: [
    { id: 'br_main', name: 'Main Branch', currency: 'UGX', status: 'open', openingCash: 24000000, expectedCash: 31850000, actualCash: 31820000 },
    { id: 'br_fx', name: 'Forex Desk', currency: 'USD', status: 'open', openingCash: 12000, expectedCash: 14350, actualCash: 14350 },
    { id: 'br_juba', name: 'Juba Desk', currency: 'SSP', status: 'closed', openingCash: 960000, expectedCash: 1180000, actualCash: 1180000 }
  ],
  users: [
    { id: 'u_owner', name: 'Amina Finance', email: 'owner@acme.test', role: 'Tenant Owner', status: 'active', branch: 'Main Branch' },
    { id: 'u_teller', name: 'Grace Teller', email: 'grace@acme.test', role: 'Money Transfer Teller', status: 'active', branch: 'Main Branch' },
    { id: 'u_forex', name: 'John Forex', email: 'john@acme.test', role: 'Forex Teller', status: 'active', branch: 'Forex Desk' }
  ],
  roles: [
    { name: 'Tenant Owner', permissions: ['*'], users: 1 },
    { name: 'Branch Manager', permissions: ['dashboard.view','branches.close_day','reports.view','analytics.view'], users: 2 },
    { name: 'Money Transfer Teller', permissions: ['money_transfer.view','money_transfer.create','money_transfer.payout'], users: 3 },
    { name: 'Forex Teller', permissions: ['forex.view','forex.buy','forex.sell'], users: 2 }
  ],
  customers: [
    { id: 'cus_1', name: 'Mary Akello', phone: '+256 701 111 222', kyc: 'verified', accounts: 1, balance: 2450000 },
    { id: 'cus_2', name: 'Deng Chol', phone: '+211 920 888 777', kyc: 'pending', accounts: 0, balance: 0 },
    { id: 'cus_3', name: 'Sarah Namutebi', phone: '+256 777 222 111', kyc: 'verified', accounts: 2, balance: 800000 }
  ],
  accounts: [
    { id: 'acc_1', customer: 'Mary Akello', number: 'ACF-100001', type: 'Savings', currency: 'UGX', balance: 2450000, status: 'active' },
    { id: 'acc_2', customer: 'Sarah Namutebi', number: 'ACF-100002', type: 'Current', currency: 'UGX', balance: 800000, status: 'active' }
  ],
  transactions: [
    { id: 'txn_1', module: 'Money Transfer', reference: 'MT-260627-001', customer: 'Mary Akello', amount: 250000, currency: 'UGX', fee: 5000, status: 'pending payout', createdAt: now() },
    { id: 'txn_2', module: 'Mobile Money', reference: 'MM-260627-002', customer: 'Sarah Namutebi', amount: 180000, currency: 'UGX', fee: 2500, status: 'completed', createdAt: now() },
    { id: 'txn_3', module: 'Banking', reference: 'BK-260627-003', customer: 'Mary Akello', amount: 600000, currency: 'UGX', fee: 1500, status: 'completed', createdAt: now() },
    { id: 'txn_4', module: 'Forex', reference: 'FX-260627-004', customer: 'Deng Chol', amount: 400, currency: 'USD', fee: 10, status: 'completed', createdAt: now() }
  ],
  receipts: [
    { number: 'RCT-0001', module: 'Money Transfer', customer: 'Mary Akello', amount: 'UGX 250,000', fee: 'UGX 5,000', createdAt: now() },
    { number: 'RCT-0002', module: 'Forex', customer: 'Deng Chol', amount: 'USD 400', fee: 'USD 10', createdAt: now() }
  ],
  notifications: [
    { event: 'transfer_created_receiver', channel: 'sms', recipient: '+256 701 111 222', status: 'sent', message: 'Claim code sent with amount and branch instructions.' },
    { event: 'invoice_created', channel: 'email', recipient: 'owner@acme.test', status: 'queued', message: 'Monthly invoice generated.' }
  ],
  auditLogs: [
    { actor: 'Amina Finance', action: 'money_transfer.create', module: 'Money Transfer', ip: '127.0.0.1', createdAt: now() },
    { actor: 'John Forex', action: 'forex.rate_manage', module: 'Forex', ip: '127.0.0.1', createdAt: now() }
  ],
  expenses: [
    { type: 'Office', description: 'Branch internet', amount: 120000, currency: 'UGX', date: '2026-06-27' },
    { type: 'Transport', description: 'Cash delivery', amount: 80000, currency: 'UGX', date: '2026-06-27' }
  ],
  forexRates: [
    { pair: 'USD/UGX', buy: 3700, sell: 3750, status: 'active' },
    { pair: 'KSH/UGX', buy: 28, sell: 30, status: 'active' },
    { pair: 'SSP/UGX', buy: 9, sell: 12, status: 'approval needed' }
  ]
};

const platformUsers = [
  { name: 'Classic Super Admin', email: 'admin@classicfinhub.test', role: 'Super Admin', status: 'active' },
  { name: 'Onboarding Officer', email: 'onboarding@classicfinhub.test', role: 'Sales/Onboarding Officer', status: 'active' },
  { name: 'Support Officer', email: 'support@classicfinhub.test', role: 'Support Officer', status: 'active' }
];

const auditLogs = [
  { actor: 'Classic Super Admin', action: 'tenant.created', module: 'Platform', record: 'Acme Forex & Transfers', createdAt: now() },
  { actor: 'Onboarding Officer', action: 'appointment.confirmed', module: 'Appointments', record: 'South Sudan Transfer Desk', createdAt: now() },
  { actor: 'Billing Officer', action: 'invoice.generated', module: 'Billing', record: 'INV-2026-0002', createdAt: now() }
];

function createAppointment(payload) {
  const item = { id: uid('apt'), businessName: payload.businessName || payload.company || 'New Business', contactName: payload.contactName || payload.name || 'Contact', email: payload.email || '', phone: payload.phone || '', modules: [].concat(payload.modules || payload.module || []).filter(Boolean), preferredDate: payload.preferredDate || payload.date || '', status: 'pending', meetingLink: '', notes: payload.notes || '', createdAt: now() };
  appointments.unshift(item);
  return item;
}

function createTenant(payload) {
  const slug = (payload.slug || payload.name || 'tenant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const id = uid('ten');
  const tenant = { id, name: payload.name || 'New Tenant', slug, dbName: `classicfin_tenant_${slug.replace(/-/g,'_')}_db`, owner: payload.owner || 'Tenant Owner', phone: payload.phone || '', email: payload.email || '', plan: payload.plan || 'starter_trial', status: payload.status || 'trial', setupStatus: 'invited', trialEndsAt: payload.trialEndsAt || null, branches: 1, enabledModules: [].concat(payload.enabledModules || ['money_transfer','mobile_money']).filter(Boolean) };
  tenants.unshift(tenant);
  auditLogs.unshift({ actor: 'Classic Super Admin', action: 'tenant.created', module: 'Tenants', record: tenant.name, createdAt: now() });
  return tenant;
}

function requestModule(tenantId, moduleKey, reason) {
  const tenant = tenants.find(t => t.id === tenantId) || tenants[0];
  const mod = modules.find(m => m.key === moduleKey);
  const req = { id: uid('mr'), tenantId: tenant.id, tenantName: tenant.name, moduleKey, moduleName: mod?.name || moduleKey, requestedBy: tenant.owner, reason: reason || 'Requested from tenant module marketplace.', status: 'pending', requestedAt: now(), platformAdminNote: '' };
  moduleRequests.unshift(req);
  return req;
}

function approveModuleRequest(id, note='Approved') {
  const req = moduleRequests.find(r => r.id === id);
  if (!req) return null;
  req.status = 'approved'; req.platformAdminNote = note; req.reviewedAt = now();
  const tenant = tenants.find(t => t.id === req.tenantId);
  if (tenant && !tenant.enabledModules.includes(req.moduleKey)) tenant.enabledModules.push(req.moduleKey);
  return req;
}

function rejectModuleRequest(id, note='Rejected') {
  const req = moduleRequests.find(r => r.id === id);
  if (!req) return null;
  req.status = 'rejected'; req.platformAdminNote = note; req.reviewedAt = now();
  return req;
}

function addTenantTransaction(module, payload) {
  const id = uid('txn');
  const item = { id, module, reference: `${module.split(' ').map(w=>w[0]).join('').toUpperCase()}-${Date.now().toString().slice(-6)}`, customer: payload.customer || payload.customerName || 'Walk-in Customer', amount: Number(payload.amount || 0), currency: payload.currency || 'UGX', fee: Number(payload.fee || 0), status: payload.status || 'completed', createdAt: now() };
  tenantState.transactions.unshift(item);
  tenantState.receipts.unshift({ number: `RCT-${Date.now().toString().slice(-6)}`, module, customer: item.customer, amount: `${item.currency} ${item.amount.toLocaleString()}`, fee: `${item.currency} ${item.fee.toLocaleString()}`, createdAt: item.createdAt });
  return item;
}

module.exports = { modules, plans, tenants, appointments, moduleRequests, invoices, payments, platformUsers, auditLogs, tenantState, createAppointment, createTenant, requestModule, approveModuleRequest, rejectModuleRequest, addTenantTransaction };
