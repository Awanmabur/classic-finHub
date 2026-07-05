const { invoices, payments } = require('../../data/store');
function listInvoices() { return invoices; }
function listPayments() { return payments; }
function recordPayment(invoiceId, amount) { const payment = { id: `pay_${Date.now()}`, invoice: invoiceId, amount, currency: 'USD', status: 'success', paidAt: new Date().toISOString() }; payments.unshift(payment); return payment; }
module.exports = { listInvoices, listPayments, recordPayment };
