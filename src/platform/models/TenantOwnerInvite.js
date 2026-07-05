const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  tenantId: { type: String },
  email: { type: String },
  tokenHash: { type: String },
  status: { type: String },
  expiresAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.models.TenantOwnerInvite || mongoose.model('TenantOwnerInvite', schema);
