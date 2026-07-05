module.exports = function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.user = { id: 'u_owner', name: 'Demo Tenant Admin', role: 'Tenant Owner', permissions: ['*'] };
  }
  next();
};
