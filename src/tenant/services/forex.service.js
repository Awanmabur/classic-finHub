const { addTenantTransaction } = require('../../data/store');
function buy(payload) { return addTenantTransaction('Forex', { ...payload, status: 'buy completed' }); }
function sell(payload) { return addTenantTransaction('Forex', { ...payload, status: 'sell completed' }); }
module.exports = { buy, sell };
