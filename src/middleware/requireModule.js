module.exports = function requireModule(moduleKey) {
  return (req, res, next) => {
    if (!req.tenant || req.tenant.enabledModules.includes(moduleKey)) return next();
    return res.status(403).render('layouts/dashboard', {
      context: 'tenant',
      currentPath: req.path,
      pageTitle: 'Module unavailable',
      pageSub: 'This module is not enabled for the tenant.',
      tenant: req.tenant,
      user: req.session.user,
      menu: require('../services/menu.service').tenantMenu(req.tenant, req.session.user),
      view: '../partials/empty-state',
      data: { icon: 'fa-lock', title: 'Module disabled', message: 'Request this module from the marketplace or billing page.' },
      flash: null,
      money: require('../utils/view').money
    });
  };
};
