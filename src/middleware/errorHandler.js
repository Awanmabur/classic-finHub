module.exports = function errorHandler(err, req, res, next) {
  console.error(err);
  res.status(err.status || 500).render('layouts/public', {
    title: 'Something went wrong',
    view: '../public/error',
    flash: { type: 'bad', message: err.message || 'Unexpected error' },
    data: { error: err },
    currentPath: req.path
  });
};
