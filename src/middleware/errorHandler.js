module.exports = function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  // JSON parser messages can quote the submitted body, including passwords and
  // activation tokens. Database errors may also contain private field values.
  // Never write arbitrary exception messages to the shared request log.
  const invalidJson = err.type === 'entity.parse.failed';
  const diagnostics = require('../utils/errorDiagnostics').inspect(err);
  const reference = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(req.requestId||'') ? req.requestId : null;
  const publicMessage = invalidJson ? 'The request body must contain valid JSON.' :
    status >= 500 ? diagnostics.publicMessage || 'An unexpected error occurred. Please try again later.' : err.message;
  const reason = invalidJson ? 'invalid_json' : status >= 500 ? 'internal_error' : 'request_rejected';
  console.error(JSON.stringify({ severity: 'error', requestId: reference, path: typeof req.path==='string'?req.path.slice(0,256):undefined, status, reason, version:require('../../package.json').version, errorType:diagnostics.errorType, errorCode:diagnostics.errorCode, source:diagnostics.source }));
  if(reference)res.setHeader?.('X-Error-Reference',reference);
  res.status(status).type('text/plain').send(publicMessage+(status>=500&&reference?'\nReference: '+reference:''));
};
