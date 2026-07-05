const { addTenantTransaction } = require('../../data/store');
function deposit(payload) { return addTenantTransaction('Banking', { ...payload, status: 'deposit completed' }); }
function withdraw(payload) { return addTenantTransaction('Banking', { ...payload, status: 'withdrawal completed' }); }
module.exports = { deposit, withdraw };
