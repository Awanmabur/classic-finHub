const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  moduleKey: { type: mongoose.Schema.Types.Mixed },
  eventKey: { type: mongoose.Schema.Types.Mixed },
  channel: { type: mongoose.Schema.Types.Mixed },
  recipient: { type: mongoose.Schema.Types.Mixed },
  message: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed },
  provider: { type: mongoose.Schema.Types.Mixed },
  error: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
