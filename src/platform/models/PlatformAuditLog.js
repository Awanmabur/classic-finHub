const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  actorId: { type: String, required:true, immutable:true },
  actorName: { type: String },
  action: { type: String, required:true, immutable:true },
  moduleKey: { type: String, immutable:true },
  recordId: { type: String, immutable:true },
  before: { type: mongoose.Schema.Types.Mixed },
  after: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true, strict:'throw' });
schema.index({createdAt:-1});
schema.index({moduleKey:1,createdAt:-1});

module.exports = mongoose.models.PlatformAuditLog || mongoose.model('PlatformAuditLog', schema);
