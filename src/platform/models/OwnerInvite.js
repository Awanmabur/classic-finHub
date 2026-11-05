const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  email: { type: String, required: true, lowercase: true },
  name: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, required: true }
}, { timestamps: true, strict: 'throw' });
schema.index({ expiresAt: 1 });
module.exports = mongoose.models.OwnerInvite || mongoose.model('OwnerInvite', schema);
