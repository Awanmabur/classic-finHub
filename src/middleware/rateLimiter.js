const rateLimit = require('express-rate-limit');
const general = rateLimit({ windowMs: 15 * 60 * 1000, max: 250, standardHeaders: 'draft-7', legacyHeaders: false, skip: req => req.path === '/health/live' || req.path === '/health/ready' });
const login = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: 'draft-7', legacyHeaders: false, // Failed logins redirect with 303, so successful-status skipping would also skip failures.
  skipSuccessfulRequests: false });
module.exports = { general, login };
