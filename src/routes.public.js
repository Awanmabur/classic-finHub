const express = require('express');
const crypto = require('crypto');
const store = require('./data/store');
const { consumeFlash, flash } = require('./utils/view');
const Appointment = require('./platform/models/Appointment');
const { authenticate, acceptInvite } = require('./platform/services/authentication.service');
const { consumeAttempt } = require('./platform/services/loginThrottle.service');
const { record: recordSecurityEvent } = require('./platform/services/securityEvent.service');
const { login } = require('./middleware/rateLimiter');
const { appUrl } = require('./config/env');
const seo = require('./config/seo');
const router = express.Router();
const original = ['home','services','pricing','price-compare','about','faq','support','terms','privacy','cookies','refund-policy','signin','signup','forgot-password','reset-password'];
for (const name of original) router.get(name === 'home' ? '/' : '/' + name, async (req, res, next) => {
  try {
  const canonicalPath = name === 'home' ? '/' : '/' + name;
  if (req.path !== canonicalPath) return res.redirect(308, canonicalPath + (req.originalUrl.includes('?') ? '?' + req.originalUrl.split('?').slice(1).join('?') : ''));
  res.setHeader('Cache-Control','private, no-store');
  if (name === 'forgot-password' || name === 'reset-password') res.setHeader('Referrer-Policy', 'no-referrer');
  const catalogue=['home','pricing','price-compare'].includes(name)
    ? await require('./platform/services/publicPlans.service').publicPlans() : {plans:store.plans,persisted:false};
  if(catalogue.unavailable&&name!=='home')res.status(503).set({'Retry-After':'60','X-Robots-Tag':'noindex, nofollow, noarchive'});
  res.render('original/' + name, { flash: consumeFlash(req), plans:catalogue.plans, cataloguePersisted:catalogue.persisted,catalogueUnavailable:Boolean(catalogue.unavailable),selectableModules:require('./utils/selectionOptions').publicModuleOptions() });
  }catch(error){next(error);}
});
function renderPublic(req, res, view, title, data = {}) {
  const path=req.path.replace(/\/+$/,'').toLowerCase()||'/';
  if(seo.INDEXABLE_PATHS.includes(path)&&req.path!==path)return res.redirect(308,path+(req.originalUrl.includes('?')?'?'+req.originalUrl.split('?').slice(1).join('?'):''));
  res.setHeader('Cache-Control','private, no-store');
  res.render('layouts/public', { title, pageMeta:seo.publicMetadata(req.path,title), jsonLd:seo.jsonLd, view: `../public/${view}`, data, flash: consumeFlash(req), currentPath: req.path,
    modules: store.modules, plans: store.plans, tenants: [], appointments: [] });
}
router.get('/marketplace', (req, res) => renderPublic(req, res, 'marketplace', 'Module Marketplace | ClassicFin Hub'));
router.get('/product-guide', (req,res) => {if(req.path.endsWith('/'))return res.redirect(308,'/product-guide');renderPublic(req,res,'product-guide','Product and operating guide | ClassicFin Hub');});
router.get('/book-appointment', (req, res) => res.redirect('/#book'));
router.post(['/book-appointment','/signup'], require('./platform/services/actionThrottle.service').appointment, async (req, res, next) => {
  try {
    const b = req.body;
    const item = {
      businessName: String(b.businessName || b['Business name'] || b.company || 'Business enquiry').trim().slice(0,150),
      contactName: String(b.contactName || b['Owner name'] || b.Owner || b.name || '').trim().slice(0,120),
      email: String(b.email || b.Email || '').trim().slice(0,254),
      phone: String(b.phone || b.Phone || '').trim().slice(0,40),
      modules: require('./utils/selectionOptions').parsePublicModuleSelection(b.modules!==undefined?b.modules:b.Modules),
      notes: String(b.Message || b.notes || '').slice(0,1000), status: 'pending'
    };
    if (!item.contactName || !(item.email || item.phone)) return res.status(400).send('Contact name and email or phone are required');
    if (item.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email)) return res.status(400).send('Enter a valid contact email address');
    if (item.phone && !/^\+?[0-9 ()-]{7,25}$/.test(item.phone)) return res.status(400).send('Enter a valid contact telephone number');
    const date = b['Demo date'] || b.preferredDate;
    if (date) {
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).send('Enter a valid preferred appointment date');
      const parsed = new Date(`${date}T12:00:00.000Z`);
      if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0,10) !== date || parsed < new Date(Date.now()-86400000) || parsed > new Date(Date.now()+180*86400000)) return res.status(400).send('Select a future appointment date within six months');
      item.preferredDate = parsed;
    }
    await Appointment.create(item);
    flash(req, 'good', 'Your request was received. Our team can follow up using your contact details.');
    res.redirect(303, '/signup');
  } catch (e) { if(e.message==='Choose modules from the available list'||e.message==='Duplicate module selection'||e.message==='Select at most one of each listed module') return res.status(400).send(e.message); next(e); }
});
router.post('/signin', login, async (req, res, next) => {
  try {
    await consumeAttempt(req.body.email, req.ip);
    const result = await authenticate(req.body);
    await recordSecurityEvent(result ? ((result.platformId || result.mfaRequired) ? 'auth.login.password_validated' : 'auth.login.success') : 'auth.login.failed', { email: req.body.email, ip: req.ip, identityId: result?.identityId });
    if (!result) { flash(req, 'bad', 'Invalid email or password.'); return res.redirect(303, '/signin'); }
    if (result.platformId) {
      // Password-only sessions have NO administrator permissions. They must complete MFA.
      const Admin = require('./platform/models/PlatformAdmin');
      const account = await Admin.findById(result.platformId).select('mfaEnabledAt').lean();
      if (!account) return res.status(401).send('Sign in again.');
      req.session.regenerate(err => {
        if (err) return next(err);
        req.session.pendingMfa = { ...result, mode:account.mfaEnabledAt ? 'challenge' : 'setup', accountEmail: req.body.email.toLowerCase().trim(), startedAt:Date.now(), attempts:0 };
        req.session.save(err2 => err2 ? next(err2) : res.redirect(303, account.mfaEnabledAt ? '/mfa/challenge' : '/mfa/setup'));
      });
      return;
    }
    if (result.mfaRequired) {
      req.session.regenerate(err => {
        if (err) return next(err);
        req.session.pendingMfa = { kind: 'tenant', tenantId: result.tenantId, tenantUserId: result.tenantUserId,
          identityId: result.identityId, authVersion: result.authVersion, mode: result.mfaEnrolled ? 'challenge' : 'setup',
          accountEmail: String(req.body.email).toLowerCase().trim(), startedAt: Date.now(), attempts: 0 };
        req.session.save(err2 => err2 ? next(err2) : res.redirect(303, result.mfaEnrolled ? '/mfa/challenge' : '/mfa/setup'));
      });
      return;
    }
    req.session.regenerate(err => {
      if (err) return next(err);
      const { tenantId, tenantUserId, identityId, authVersion } = result;
      Object.assign(req.session, { tenantId, tenantUserId, identityId, authVersion, authenticatedAt: Date.now() });
      req.session.save(err2 => err2 ? next(err2) : res.redirect(303, '/tenant/dashboard'));
    });
  } catch (e) { next(e); }
});
router.post('/logout', (req, res, next) => req.session.destroy(err => {
  if (err) return next(err);
  res.clearCookie('cfh.sid'); res.redirect(303, '/signin');
}));
router.get('/accept-invite', (req, res) => {
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Cache-Control','no-store');
  res.render('auth/accept-invite', { flash: consumeFlash(req) });
});
router.post('/accept-invite', login, async (req, res, next) => {
  try {
    if (req.body.password !== req.body.confirmPassword) return res.status(400).send('Passwords do not match');
    await acceptInvite(req.body.token, req.body.password);
    flash(req, 'good', 'Your account is activated. Sign in with your email and password.');
    res.redirect(303, '/signin');
  } catch (e) { next(e); }
});
router.get('/accept-staff-invite',(req,res)=>{
  res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
  const slug=typeof req.query.tenant==='string' ? req.query.tenant : '';
  res.render('auth/accept-staff-invite',{slug});
});
router.post('/accept-staff-invite',login,async(req,res,next)=>{
  try{
    if(req.body.password!==req.body.confirmPassword)return res.status(400).send('Passwords do not match');
    await require('./tenant/services/staff.service').acceptStaffInvite(req.body.slug,req.body.token,req.body.password);
    flash(req,'good','Staff account activated. Sign in with your email and password.');res.redirect(303,'/signin');
  }catch(e){next(e);}
});
router.post('/forgot-password', login, async (req, res, next) => {
  try {
    if (!require('./config/mail').configured()) return res.status(503).send('Password reset email is temporarily unavailable. Contact support.');
    await require('./platform/services/passwordRecovery.service').requestReset(req.body.email, req.ip);
    flash(req, 'good', 'If an active account exists for that email, you will receive a password reset link.');
    res.redirect(303, '/forgot-password');
  } catch (e) { next(e); }
});
router.post('/reset-password', login, async (req, res, next) => {
  try {
    await require('./platform/services/passwordRecovery.service').completeReset(req.body.token, req.body.password, req.body.confirmPassword, req.ip);
    flash(req, 'good', 'Password updated. Sign in again on all devices.');
    res.redirect(303, '/signin');
  } catch (e) { next(e); }
});
router.get('/t/:slug', async (req, res, next) => {
  try {
    // Fail promptly during a database outage rather than buffering a public
    // mongoose query for ten seconds. Tenant landing pages are never cached.
    const mongoose = require('mongoose');
    const { NAME } = require('./config/mongo');
    if (!NAME.test(req.params.slug)) return res.status(404).send('Tenant page not found');
    if (mongoose.connection.readyState !== 1) return res.status(503).send('Tenant pages are temporarily unavailable');
    const Tenant = require('./platform/models/Tenant');
    const tenant = await Tenant.findOne({ slug: req.params.slug, status: { $in:['active','trial'] } }).lean();
    if (!tenant) return res.status(404).send('Tenant page not found');
    const landing=await require('./tenant/workspace/service').publicLanding(require('./config/mongo').getTenantConnection(tenant.slug),tenant);
    if(!landing)return res.status(404).send('Tenant page not found');
    res.set('Cache-Control','no-store');
    renderPublic(req, res, 'tenant-landing', `${landing?.name||tenant.name} | ClassicFin Hub`, { tenant,landing });
  } catch (e) { next(e); }
});
router.get('/robots.txt', (req,res) => res.type('text/plain').set('Cache-Control','public, max-age=1800').send(seo.robotsTxt()));
router.get('/sitemap.xml', (req,res) => res.type('application/xml').set('Cache-Control','public, max-age=1800').send(seo.sitemapXml()));
router.get('/llms.txt', (req,res) => res.type('text/plain').set('Cache-Control','public, max-age=1800').send(seo.llmsTxt()));
module.exports = router;
