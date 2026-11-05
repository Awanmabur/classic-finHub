'use strict';
// Legacy demonstration service entrypoints must NEVER claim that an unpersisted
// payment, ledger posting, customer update or background job succeeded.
module.exports = function unavailableOperation(name) {
  const error = new Error(`${name} is not enabled. No records or funds were changed.`);
  error.status = 501;
  throw error;
};
