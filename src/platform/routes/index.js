const express = require('express');
const store = require('../../data/store');
const { platformMenu } = require('../../services/menu.service');
const { consumeFlash, flash, money } = require('../../utils/view');
const { provisionTenant } = require('../services/tenantProvisioning.service');
const { confirmAppointment, completeAppointment } = require('../services/appointment.service');
const { toggleModule } = require('../services/module.service');
const { approveModuleRequest, rejectModuleRequest } = require('../services/moduleRequest.service');

const router = express.Router();

function renderPlatform(req, res, view, pageTitle, pageSub, data = {}) {
  res.render('layouts/dashboard', {
    context: 'platform', currentPath: req.path, pageTitle, pageSub,
    tenant: null, user: req.session.platformUser, menu: platformMenu(),
    view: `../platform/${view}`, data, flash: consumeFlash(req), money
  });
}

router.get('/', (req, res) => res.redirect('/platform/dashboard'));
router.get('/dashboard', (req, res) => renderPlatform(req, res, 'dashboard/index', 'Platform Dashboard', 'Appointments, tenants, plans, modules, subscriptions, billing, analytics, and audit logs.', store));
router.get('/appointments', (req, res) => renderPlatform(req, res, 'appointments/index', 'Appointments', 'Appointment-led onboarding before tenant creation.', store));
router.post('/appointments/:id/confirm', (req, res) => { confirmAppointment(req.params.id, req.body.meetingLink); flash(req, 'good', 'Appointment confirmed and meeting link prepared.'); res.redirect('/platform/appointments'); });
router.post('/appointments/:id/complete', (req, res) => { completeAppointment(req.params.id); flash(req, 'good', 'Appointment marked complete. You can now create the tenant.'); res.redirect('/platform/appointments'); });

router.get('/tenants', (req, res) => renderPlatform(req, res, 'tenants/index', 'Tenants', 'Create, review, suspend, reactivate, bill, and support tenants.', store));
router.get('/tenants/create', (req, res) => renderPlatform(req, res, 'tenants/create', 'Create Tenant', 'Provision tenant DB, seed defaults, and send tenant owner invitation.', store));
router.post('/tenants', (req, res) => { const result = provisionTenant(req.body); flash(req, 'good', `${result.tenant.name} created with ${result.database}. Owner invite is ready.`); res.redirect(`/platform/tenants/${result.tenant.id}`); });
router.get('/tenants/:id', (req, res) => { const tenant = store.tenants.find(t => t.id === req.params.id) || store.tenants[0]; renderPlatform(req, res, 'tenants/show', tenant.name, 'Tenant profile, modules, billing, subscription, and isolation settings.', { ...store, tenant }); });

router.get('/modules', (req, res) => renderPlatform(req, res, 'modules/index', 'Modules', 'Platform registry for money transfer, mobile money, banking, forex, and addons.', store));
router.post('/modules/:key/toggle', (req, res) => { const mod = toggleModule(req.params.key); flash(req, 'good', `${mod?.name || 'Module'} status updated.`); res.redirect('/platform/modules'); });
router.get('/marketplace', (req, res) => renderPlatform(req, res, 'marketplace/index', 'Platform Marketplace', 'Sell modules and addons from the module registry.', store));

router.get('/plans', (req, res) => renderPlatform(req, res, 'plans/index', 'Plans', 'Plan versions, modules, limits, prices, and trial terms.', store));
router.get('/plans/editor', (req, res) => renderPlatform(req, res, 'plans/editor', 'Plan Editor', 'Attach modules, addons, prices, limits, and trials.', store));
router.get('/module-requests', (req, res) => renderPlatform(req, res, 'module-requests/index', 'Module Requests', 'Review tenant module requests, approve/reject, invoice addons, and activate modules.', store));
router.post('/module-requests/:id/approve', (req, res) => { approveModuleRequest(req.params.id, req.body.note || 'Approved by platform.'); flash(req, 'good', 'Module request approved and tenant module activated.'); res.redirect('/platform/module-requests'); });
router.post('/module-requests/:id/reject', (req, res) => { rejectModuleRequest(req.params.id, req.body.note || 'Rejected by platform.'); flash(req, 'bad', 'Module request rejected.'); res.redirect('/platform/module-requests'); });
router.get('/subscriptions', (req, res) => renderPlatform(req, res, 'subscriptions/index', 'Subscriptions', 'Trials, active plans, suspension, grace period, and billing restrictions.', store));
router.get('/invoices', (req, res) => renderPlatform(req, res, 'invoices/index', 'Invoices', 'Invoices generated from trials, plans, modules, and addons.', store));
router.get('/payments', (req, res) => renderPlatform(req, res, 'payments/index', 'Payments', 'Payment provider status and reconciliation.', store));
router.get('/users', (req, res) => renderPlatform(req, res, 'users/index', 'Platform Users', 'Classic Technologies users and platform roles.', store));
router.get('/audit-logs', (req, res) => renderPlatform(req, res, 'audit/index', 'Platform Audit Logs', 'Audit every sensitive platform action.', store));
router.get('/settings', (req, res) => renderPlatform(req, res, 'settings/index', 'Platform Settings', 'Security, system settings, tenant isolation, and environment controls.', store));

module.exports = router;
