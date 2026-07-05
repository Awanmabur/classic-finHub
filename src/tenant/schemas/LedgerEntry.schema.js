const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  moduleKey: { type: mongoose.Schema.Types.Mixed },
  reference: { type: mongoose.Schema.Types.Mixed },
  debit: { type: mongoose.Schema.Types.Mixed },
  credit: { type: mongoose.Schema.Types.Mixed },
  currency: { type: mongoose.Schema.Types.Mixed },
  branchId: { type: mongoose.Schema.Types.Mixed },
  createdBy: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
