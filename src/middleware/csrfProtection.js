module.exports = function csrfProtection(req, res, next) {
  res.locals.csrfToken = '';
  next();
};
