const { hasModuleForUser } = require('../tenant/services/moduleAccess.service');
module.exports = function requireModule(moduleKey) {
  return (req,res,next) => hasModuleForUser(req.tenant,req.user,moduleKey) ? next() : res.status(403).send('This module is not assigned to your account or subscription.');
};
