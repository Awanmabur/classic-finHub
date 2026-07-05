const express = require('express');
const store = require('./data/store');
const { consumeFlash, flash } = require('./utils/view');
const { bookAppointment } = require('./platform/services/appointment.service');

const router = express.Router();

function renderOriginal(res, page) {
  res.render(`original/${page}`);
}

function renderPublic(req, res, view, title, data = {}) {
  res.render('layouts/public', {
    title,
    view: `../public/${view}`,
    data,
    flash: consumeFlash(req),
    currentPath: req.path,
    modules: store.modules,
    plans: store.plans,
    tenants: store.tenants,
    appointments: store.appointments
  });
}

router.get('/', (req, res) => renderOriginal(res, 'home'));
router.get('/services', (req, res) => renderOriginal(res, 'services'));
router.get('/pricing', (req, res) => renderOriginal(res, 'pricing'));
router.get('/price-compare', (req, res) => renderOriginal(res, 'price-compare'));
router.get('/about', (req, res) => renderOriginal(res, 'about'));
router.get('/faq', (req, res) => renderOriginal(res, 'faq'));
router.get('/support', (req, res) => renderOriginal(res, 'support'));
router.get('/terms', (req, res) => renderOriginal(res, 'terms'));
router.get('/privacy', (req, res) => renderOriginal(res, 'privacy'));
router.get('/cookies', (req, res) => renderOriginal(res, 'cookies'));
router.get('/refund-policy', (req, res) => renderOriginal(res, 'refund-policy'));
router.get('/signin', (req, res) => renderOriginal(res, 'signin'));
router.get('/signup', (req, res) => renderOriginal(res, 'signup'));
router.get('/forgot-password', (req, res) => renderOriginal(res, 'forgot-password'));
router.get('/reset-password', (req, res) => renderOriginal(res, 'reset-password'));
router.get('/book-appointment', (req, res) => res.redirect('/#book'));

router.get('/marketplace', (req, res) => renderPublic(req, res, 'marketplace', 'Module Marketplace | ClassicFin Hub'));

router.post('/book-appointment', (req, res) => {
  bookAppointment(req.body);
  flash(req, 'good', 'Appointment request submitted. Platform onboarding can now confirm and create a tenant.');
  res.redirect(303, '/platform/appointments');
});

router.post('/signup', (req, res) => {
  bookAppointment(req.body);
  flash(req, 'good', 'Setup request submitted. The platform team can review it under appointments.');
  res.redirect(303, '/platform/appointments');
});

router.post('/signin', (req, res) => {
  if (req.body.side === 'platform') {
    req.session.platformUser = { name: 'Classic Super Admin', role: 'Super Admin', permissions: ['*'] };
    return res.redirect(303, '/platform/dashboard');
  }
  req.session.user = { name: 'Demo Tenant Admin', role: 'Tenant Owner', permissions: ['*'] };
  res.redirect(303, '/tenant/dashboard');
});

router.post('/forgot-password', (req, res) => {
  flash(req, 'good', 'Password reset link queued with the mock email provider.');
  res.redirect(303, '/signin');
});

router.post('/reset-password', (req, res) => {
  flash(req, 'good', 'Password updated in demo flow.');
  res.redirect(303, '/signin');
});

router.get('/t/:slug', (req, res) => {
  const tenant = store.tenants.find(t => t.slug === req.params.slug) || store.tenants[0];
  renderPublic(req, res, 'tenant-landing', `${tenant.name} | ClassicFin Hub`, { tenant });
});

module.exports = router;
