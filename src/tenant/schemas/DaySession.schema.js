const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  branchId: { type: mongoose.Schema.Types.Mixed },
  date: { type: mongoose.Schema.Types.Mixed },
  openingCash: { type: mongoose.Schema.Types.Mixed },
  expectedCash: { type: mongoose.Schema.Types.Mixed },
  actualCash: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed },
  closedBy: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
