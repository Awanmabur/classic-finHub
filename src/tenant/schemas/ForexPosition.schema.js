const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  currency: { type: mongoose.Schema.Types.Mixed },
  stockAmount: { type: mongoose.Schema.Types.Mixed },
  averageRate: { type: mongoose.Schema.Types.Mixed },
  branchId: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
