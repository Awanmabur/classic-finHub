const entries = [];
function postEntry({ moduleKey, reference, debit = 0, credit = 0, currency = 'UGX', branchId, createdBy }) {
  const entry = { id: `led_${Date.now()}`, moduleKey, reference, debit, credit, currency, branchId, createdBy, createdAt: new Date().toISOString() };
  entries.unshift(entry); return entry;
}
module.exports = { postEntry, entries };
