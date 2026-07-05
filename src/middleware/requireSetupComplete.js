module.exports = function requireSetupComplete(req, res, next) {
  if (req.tenant?.setupStatus !== 'complete' && !req.path.includes('/setup')) return res.redirect('/tenant/setup');
  next();
};
