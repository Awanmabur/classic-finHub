const { addTenantTransaction } = require('../../data/store');
function sendMoney(payload) { return addTenantTransaction('Money Transfer', { ...payload, status: 'pending payout' }); }
function payoutByPin(payload) { return addTenantTransaction('Money Transfer', { ...payload, status: 'paid out' }); }
module.exports = { sendMoney, payoutByPin };
