const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  tenantId: { type: String },
  planCode: { type: String },
  status: { type: String },
  trialEndsAt: { type: Date },
  currentPeriodEnd: { type: Date }
}, { timestamps: true });

module.exports = mongoose.models.Subscription || mongoose.model('Subscription', schema);
