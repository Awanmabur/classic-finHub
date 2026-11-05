const { hasPermission } = require('../tenant/services/moduleAccess.service');
module.exports = function requirePermission(permission) {
  return (req, res, next) => {
    if (hasPermission(req.user, permission) || (permission==='users.manage_branch' && hasPermission(req.user,'users.manage'))) return next();
    return res.status(403).send('You do not have permission for this action.');
  };
};
