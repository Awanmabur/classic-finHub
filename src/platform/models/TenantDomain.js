const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  tenantId: { type: String },
  domain: { type: String },
  status: { type: String }
}, { timestamps: true });

module.exports = mongoose.models.TenantDomain || mongoose.model('TenantDomain', schema);
