const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  key: { type: mongoose.Schema.Types.Mixed },
  value: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
