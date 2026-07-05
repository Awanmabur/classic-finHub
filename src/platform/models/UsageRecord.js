const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  tenantId: { type: String },
  moduleKey: { type: String },
  metric: { type: String },
  quantity: { type: Number },
  period: { type: String }
}, { timestamps: true });

module.exports = mongoose.models.UsageRecord || mongoose.model('UsageRecord', schema);
