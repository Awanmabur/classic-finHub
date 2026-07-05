module.exports = function requirePermission(permission) {
  return (req, res, next) => {
    const permissions = req.session.user?.permissions || ['*'];
    if (permissions.includes('*') || permissions.includes(permission)) return next();
    return res.status(403).send('You do not have permission for this action.');
  };
};
