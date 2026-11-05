const { randomBytes, timingSafeEqual } = require('crypto');
const safe = new Set(['GET','HEAD','OPTIONS']);
const publicFormPages = new Set(['/','/signin','/signup','/forgot-password','/reset-password','/accept-invite','/accept-staff-invite','/mfa/setup','/mfa/challenge']);
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x,y);
}
module.exports = function csrfProtection(req, res, next) {
  const readOnly = safe.has(req.method);
  // Do not create needless session records for crawlers of informational pages.
  const formPage = publicFormPages.has(req.path) || req.path.startsWith('/platform/') ||
    req.path === '/platform' || req.path.startsWith('/tenant/') || req.path === '/tenant';
  if (readOnly && formPage && !req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken || '';
  if (readOnly) return next();
  const provided = req.get('x-csrf-token') || req.body?._csrf;
  if (!equal(provided, req.session.csrfToken)) {
    const err = new Error('Request could not be verified. Refresh the page and try again.');
    err.status = 403;
    return next(err);
  }
  next();
};
