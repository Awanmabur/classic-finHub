module.exports = function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  // JSON parser messages can quote the submitted body, including passwords and
  // activation tokens. Database errors may also contain private field values.
  // Never write arbitrary exception messages to the shared request log.
  const invalidJson = err.type === 'entity.parse.failed';
  const publicMessage = invalidJson ? 'The request body must contain valid JSON.' :
    status >= 500 ? 'An unexpected error occurred. Please try again later.' : err.message;
  const reason = invalidJson ? 'invalid_json' : status >= 500 ? 'internal_error' : 'request_rejected';
  console.error(JSON.stringify({ severity: 'error', requestId: req.requestId, path: req.path, status, reason }));
  res.status(status).type('text/plain').send(publicMessage);
};
