const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  pair: { type: mongoose.Schema.Types.Mixed },
  buyRate: { type: mongoose.Schema.Types.Mixed },
  sellRate: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed },
  approvedBy: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
