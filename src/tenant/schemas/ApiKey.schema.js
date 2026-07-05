const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  name: { type: mongoose.Schema.Types.Mixed },
  keyHash: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed },
  lastUsedAt: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
