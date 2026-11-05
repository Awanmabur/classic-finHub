'use strict';
const { nodeEnv, appUrl } = require('../config/env');
const canonical = new URL(appUrl);
function canonicalOrigin(req, res, next) {
  if (nodeEnv !== 'production' || /^\/health\/(live|ready)$/.test(req.path)) return next();
  const host = req.hostname.toLowerCase();
  const allowed = new Set([canonical.hostname.toLowerCase(), `www.${canonical.hostname.toLowerCase()}`]);
  if (!allowed.has(host)) return res.status(421).type('text/plain').send('Unknown website host');
  // req.secure honors only a deliberately configured, trusted reverse proxy.
  if (host !== canonical.hostname.toLowerCase() || !req.secure) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(421).send('Use the canonical HTTPS origin');
    return res.redirect(308, `${canonical.origin}${req.originalUrl}`);
  }
  next();
}
module.exports = { canonicalOrigin };
