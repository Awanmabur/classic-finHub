const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  date: { type: mongoose.Schema.Types.Mixed },
  period: { type: mongoose.Schema.Types.Mixed },
  branchId: { type: mongoose.Schema.Types.Mixed },
  moduleKey: { type: mongoose.Schema.Types.Mixed },
  currency: { type: mongoose.Schema.Types.Mixed },
  transactionCount: { type: mongoose.Schema.Types.Mixed },
  totalVolume: { type: mongoose.Schema.Types.Mixed },
  grossProfit: { type: mongoose.Schema.Types.Mixed },
  netProfit: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
