module.exports = function tenantStatusCheck(req, res, next) {
  if (req.tenant?.status === 'suspended' && !req.path.includes('/billing') && !req.path.includes('/support')) {
    return res.redirect('/tenant/billing?restricted=suspended');
  }
  next();
};
