const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.Mixed },
  action: { type: mongoose.Schema.Types.Mixed },
  currency: { type: mongoose.Schema.Types.Mixed },
  amount: { type: mongoose.Schema.Types.Mixed },
  rate: { type: mongoose.Schema.Types.Mixed },
  fee: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed },
  reference: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
