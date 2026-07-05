const { addTenantTransaction } = require('../../data/store');
function cashIn(payload) { return addTenantTransaction('Mobile Money', { ...payload, status: 'cash-in completed' }); }
function cashOut(payload) { return addTenantTransaction('Mobile Money', { ...payload, status: 'cash-out completed' }); }
module.exports = { cashIn, cashOut };
