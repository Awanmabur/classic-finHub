const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  branchId: { type: mongoose.Schema.Types.Mixed },
  currency: { type: mongoose.Schema.Types.Mixed },
  openingCash: { type: mongoose.Schema.Types.Mixed },
  expectedCash: { type: mongoose.Schema.Types.Mixed },
  actualCash: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
