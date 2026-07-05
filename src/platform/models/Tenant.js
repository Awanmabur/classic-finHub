const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  name: { type: String },
  slug: { type: String },
  dbName: { type: String },
  owner: { type: String },
  email: { type: String },
  phone: { type: String },
  plan: { type: String },
  status: { type: String },
  enabledModules: { type: [String] },
  trialEndsAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.models.Tenant || mongoose.model('Tenant', schema);
