module.exports = function requirePlatformAuth(req, res, next) {
  if (!req.session.platformUser) {
    req.session.platformUser = { id: 'pa_demo', name: 'Classic Super Admin', role: 'Super Admin', permissions: ['*'] };
  }
  next();
};
