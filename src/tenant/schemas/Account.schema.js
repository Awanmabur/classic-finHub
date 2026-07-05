const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.Mixed },
  accountNumber: { type: mongoose.Schema.Types.Mixed },
  type: { type: mongoose.Schema.Types.Mixed },
  currency: { type: mongoose.Schema.Types.Mixed },
  balance: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
