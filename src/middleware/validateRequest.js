module.exports = function validateRequest(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      req.session.flash = { type: 'bad', message: error.details.map((detail) => detail.message).join(', ') };
      return res.redirect('back');
    }
    req.body = value;
    next();
  };
};
