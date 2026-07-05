const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  email: { type: mongoose.Schema.Types.Mixed },
  phone: { type: mongoose.Schema.Types.Mixed },
  tokenHash: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed },
  expiresAt: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
