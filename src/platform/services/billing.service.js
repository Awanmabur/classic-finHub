'use strict';
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const unavailable = require('../../utils/unavailableOperation');
async function listInvoices() { return Invoice.find({}).sort({createdAt:-1}).limit(100).lean(); }
async function listPayments() { return Payment.find({}).sort({createdAt:-1}).limit(100).lean(); }
function recordPayment() { return unavailable('Billing provider settlement'); }
module.exports={listInvoices,listPayments,recordPayment};
