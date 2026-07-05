const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.Mixed },
  network: { type: mongoose.Schema.Types.Mixed },
  type: { type: mongoose.Schema.Types.Mixed },
  amount: { type: mongoose.Schema.Types.Mixed },
  currency: { type: mongoose.Schema.Types.Mixed },
  fee: { type: mongoose.Schema.Types.Mixed },
  reference: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
