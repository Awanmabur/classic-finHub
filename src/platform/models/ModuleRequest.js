const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  tenantId: { type: String },
  moduleKey: { type: String },
  requestedBy: { type: String },
  reason: { type: String },
  status: { type: String },
  pricingSnapshot: { type: mongoose.Schema.Types.Mixed },
  reviewedBy: { type: String },
  platformAdminNote: { type: String }
}, { timestamps: true });

module.exports = mongoose.models.ModuleRequest || mongoose.model('ModuleRequest', schema);
