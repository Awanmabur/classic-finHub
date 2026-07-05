const express = require('express');
const store = require('../../data/store');
const { tenantMenu } = require('../../services/menu.service');
const { consumeFlash, flash, money } = require('../../utils/view');
const { requestModule } = require('../../data/store');
const moneyTransfer = require('../services/moneyTransfer.service');
const mobileMoney = require('../services/mobileMoney.service');
const banking = require('../services/banking.service');
const forex = require('../services/forex.service');

const router = express.Router();
const tenantData = () => ({ ...store.tenantState, modules: store.modules, invoices: store.invoices, analyticsCards: [
  { label: 'Today profit/loss', value: 'UGX 2,350,000', note: 'Today vs yesterday +12%' },
  { label: 'Fee income', value: 'UGX 183,500', note: 'All active modules' },
  { label: 'Best module', value: 'Forex', note: 'Highest net profit' },
  { label: 'Customer growth', value: '+18', note: 'This week' },
  { label: 'Cash discrepancy', value: 'UGX 30,000', tone: 'warn', note: 'Main Branch review' },
  { label: 'Notifications sent', value: '46', note: 'SMS + email' }
] });

function renderTenant(req, res, view, pageTitle, pageSub, data = tenantData()) {
  res.render('layouts/dashboard', {
    context: 'tenant', currentPath: req.path, pageTitle, pageSub,
    tenant: req.tenant, user: req.session.user, menu: tenantMenu(req.tenant, req.session.user),
    view: `../tenant/${view}`, data, flash: consumeFlash(req), money
  });
}

router.get('/', (req, res) => res.redirect('/tenant/dashboard'));
router.get('/dashboard', (req, res) => renderTenant(req, res, 'dashboard/index', 'Tenant Overview', 'Money transfer, mobile money, banking, forex, branches, receipts, analytics, and cash controls.'));
router.get('/setup', (req, res) => renderTenant(req, res, 'setup/index', 'Setup Wizard', 'Tenant owner setup, profile, branch, currencies, roles, staff, and customer onboarding.'));
router.get('/money-transfer', (req, res) => renderTenant(req, res, 'money-transfer/index', 'Money Transfer', 'Send money, generate claim codes, payout by PIN, notify customers, and generate receipts.'));
router.post('/money-transfer/send', (req, res) => { moneyTransfer.sendMoney(req.body); flash(req, 'good', 'Money transfer created with pending payout status and receipt.'); res.redirect('/tenant/money-transfer'); });
router.get('/mobile-money', (req, res) => renderTenant(req, res, 'mobile-money/index', 'Mobile Money', 'Cash-in, cash-out, network reference, agent float, receipts, and reconciliation.'));
router.post('/mobile-money/cash-in', (req, res) => { mobileMoney.cashIn(req.body); flash(req, 'good', 'Mobile money cash-in completed.'); res.redirect('/tenant/mobile-money'); });
router.post('/mobile-money/cash-out', (req, res) => { mobileMoney.cashOut(req.body); flash(req, 'good', 'Mobile money cash-out completed.'); res.redirect('/tenant/mobile-money'); });
router.get('/banking', (req, res) => renderTenant(req, res, 'banking/index', 'Banking', 'Accounts, deposits, withdrawals, transfers, statements, and ledger entries.'));
router.post('/banking/deposit', (req, res) => { banking.deposit(req.body); flash(req, 'good', 'Banking deposit posted and receipt generated.'); res.redirect('/tenant/banking'); });
router.post('/banking/withdraw', (req, res) => { banking.withdraw(req.body); flash(req, 'good', 'Banking withdrawal posted and receipt generated.'); res.redirect('/tenant/banking'); });
router.get('/forex', (req, res) => renderTenant(req, res, 'forex/index', 'Forex', 'Rate board, buy/sell, approval, forex stock, cash drawer impact, and forex reports.'));
router.post('/forex/buy', (req, res) => { forex.buy(req.body); flash(req, 'good', 'Forex buy recorded with receipt.'); res.redirect('/tenant/forex'); });
router.post('/forex/sell', (req, res) => { forex.sell(req.body); flash(req, 'good', 'Forex sell recorded with receipt.'); res.redirect('/tenant/forex'); });
router.get('/customers', (req, res) => renderTenant(req, res, 'customers/index', 'Customers', 'Register, invite, self-register, and verify KYC.'));
router.post('/customers', (req, res) => { store.tenantState.customers.unshift({ id: `cus_${Date.now()}`, name: req.body.name, phone: req.body.phone, kyc: req.body.kyc || 'pending', accounts: 0, balance: 0 }); flash(req, 'good', 'Customer saved.'); res.redirect('/tenant/customers'); });
router.get('/accounts', (req, res) => renderTenant(req, res, 'accounts/index', 'Accounts', 'Customer accounts, balances, movements, and statements.'));
router.get('/branches', (req, res) => renderTenant(req, res, 'branches/index', 'Branches and Day Sessions', 'Branches, cash drawers, open day, close day, expected cash, and discrepancy review.'));
router.post('/branches', (req, res) => { store.tenantState.branches.unshift({ id: `br_${Date.now()}`, name: req.body.name, currency: req.body.currency || 'UGX', status: 'open', openingCash: 0, expectedCash: 0, actualCash: 0 }); flash(req, 'good', 'Branch created and ready to open day.'); res.redirect('/tenant/branches'); });
router.get('/users', (req, res) => renderTenant(req, res, 'users/index', 'Users', 'Staff invites, users, roles, branches, and status.'));
router.get('/roles', (req, res) => renderTenant(req, res, 'roles/index', 'Roles', 'Permission editor with module access checks.'));
router.get('/reports', (req, res) => renderTenant(req, res, 'reports/index', 'Reports', 'Daily, weekly, monthly, module, branch, operator, customer, receipt, and notification reports.'));
router.get('/analytics', (req, res) => renderTenant(req, res, 'analytics/index', 'Analytics', 'Profit/loss, fees, commissions, expenses, branch, operator, network, and forex pair comparisons.'));
router.get('/expenses', (req, res) => renderTenant(req, res, 'expenses/index', 'Expenses', 'Expenses, vendors, references, cash impact, and profit/loss tracking.'));
router.get('/notifications', (req, res) => renderTenant(req, res, 'notifications/index', 'Notifications', 'Templates, SMS, email, in-app, delivery logs, and retries.'));
router.get('/receipts', (req, res) => renderTenant(req, res, 'receipts/index', 'Receipts', 'Receipt records, print, email, PDF generation, and QR codes.'));
router.get('/modules', (req, res) => renderTenant(req, res, 'modules/index', 'Tenant Modules', 'Enabled modules, available addons, role permissions, and request flow.'));
router.get('/marketplace', (req, res) => renderTenant(req, res, 'marketplace/index', 'Tenant Marketplace', 'Request modules and addons from the platform marketplace.'));
router.post('/modules/request', (req, res) => { const r = requestModule(req.tenant.id, req.body.moduleKey, req.body.reason); flash(req, 'good', `${r.moduleName} request sent to platform for approval.`); res.redirect('/tenant/modules'); });
router.get('/billing', (req, res) => renderTenant(req, res, 'billing/index', 'Billing', 'Subscription, trial, invoices, payments, grace period, and restricted billing access.'));
router.get('/landing-page', (req, res) => renderTenant(req, res, 'landing-page/index', 'Landing Page Builder', 'Tenant branding, services, contact, SEO, customer portal, and custom domain addon.'));
router.get('/settings', (req, res) => renderTenant(req, res, 'settings/index', 'Settings', 'Tenant profile, currencies, receipt template, API keys, and security.'));
router.get('/audit-logs', (req, res) => renderTenant(req, res, 'audit/index', 'Audit Logs', 'Tenant user activity, sensitive actions, and financial audit logs.'));

module.exports = router;
