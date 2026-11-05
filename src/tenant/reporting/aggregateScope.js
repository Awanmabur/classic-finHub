'use strict';
// MongoDB aggregation does not perform Mongoose's find() schema casting.
// Enforce valid IDs and convert according to each collection's stored type.
const OBJECT_ID = /^[0-9a-f]{24}$/i;
function branchMatch(scope = {}, cast = value => value) {
  if (!scope?.branchId) return {};
  const id = String(scope.branchId);
  if (!OBJECT_ID.test(id)) {
    const error = new Error('Invalid assigned reporting branch');
    error.status = 403;
    throw error;
  }
  return { branchId: cast(id) };
}
module.exports = { branchMatch };
