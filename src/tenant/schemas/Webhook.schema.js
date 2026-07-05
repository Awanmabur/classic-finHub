const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  url: { type: mongoose.Schema.Types.Mixed },
  events: { type: mongoose.Schema.Types.Mixed },
  secret: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
