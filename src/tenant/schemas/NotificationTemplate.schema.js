const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  moduleKey: { type: mongoose.Schema.Types.Mixed },
  eventKey: { type: mongoose.Schema.Types.Mixed },
  channel: { type: mongoose.Schema.Types.Mixed },
  language: { type: mongoose.Schema.Types.Mixed },
  subject: { type: mongoose.Schema.Types.Mixed },
  body: { type: mongoose.Schema.Types.Mixed },
  variables: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
