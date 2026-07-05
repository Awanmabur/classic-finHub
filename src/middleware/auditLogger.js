const { auditLogs } = require('../data/store');
module.exports = function auditLogger(action, moduleKey = 'Platform') {
  return (req, res, next) => {
    auditLogs.unshift({ actor: req.session.platformUser?.name || req.session.user?.name || 'Anonymous', action, module: moduleKey, record: req.originalUrl, createdAt: new Date().toISOString() });
    next();
  };
};
