const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  planId: { type: String },
  version: { type: String },
  modules: { type: mongoose.Schema.Types.Mixed },
  priceMonthly: { type: Number },
  priceYearly: { type: Number },
  limits: { type: mongoose.Schema.Types.Mixed },
  status: { type: String },
  effectiveFrom: { type: Date }
}, { timestamps: true });

module.exports = mongoose.models.PlanVersion || mongoose.model('PlanVersion', schema);
