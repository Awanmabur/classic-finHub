const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  actorId: { type: String },
  actorName: { type: String },
  action: { type: String },
  moduleKey: { type: String },
  recordId: { type: String },
  before: { type: mongoose.Schema.Types.Mixed },
  after: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

module.exports = mongoose.models.PlatformAuditLog || mongoose.model('PlatformAuditLog', schema);
