const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  type: { type: mongoose.Schema.Types.Mixed },
  description: { type: mongoose.Schema.Types.Mixed },
  amount: { type: mongoose.Schema.Types.Mixed },
  currency: { type: mongoose.Schema.Types.Mixed },
  vendor: { type: mongoose.Schema.Types.Mixed },
  reference: { type: mongoose.Schema.Types.Mixed },
  branchId: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
