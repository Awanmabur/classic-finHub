const helmet = require('helmet');
const crypto = require('crypto');
const { indexingEnabled } = require('../config/env');
module.exports = [
  (req, res, next) => { res.locals.cspNonce = crypto.randomBytes(16).toString('base64'); next(); },
  helmet({
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Active dashboards and public pages use external self-hosted JS; no inline scripts are allowed.
    // Existing approved HTML still uses inline style attributes; style nonces are a separate upgrade.
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], objectSrc: ["'none'"],
      formAction: ["'self'"], frameAncestors: ["'none'"], baseUri: ["'self'"], frameSrc: ["'none'"], upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    } },
    hsts: process.env.NODE_ENV === 'production' ? undefined : false
  }),
  (req, res, next) => {
    if (!indexingEnabled) res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    if (/^\/(tenant|platform|signin|signup|forgot-password|reset-password|accept-invite|accept-staff-invite|mfa)(\/|$)/.test(req.path)) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('Cache-Control', 'private, no-store');
    }
    if (req.path.startsWith('/t/') || req.path.startsWith('/health/')) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('Cache-Control','private, no-store');
    }
    next();
  }
];
