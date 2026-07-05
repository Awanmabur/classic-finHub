const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.Mixed },
  actorName: { type: mongoose.Schema.Types.Mixed },
  action: { type: mongoose.Schema.Types.Mixed },
  moduleKey: { type: mongoose.Schema.Types.Mixed },
  recordId: { type: mongoose.Schema.Types.Mixed },
  ipAddress: { type: mongoose.Schema.Types.Mixed },
  before: { type: mongoose.Schema.Types.Mixed },
  after: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
