const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  name: { type: String },
  code: { type: String },
  description: { type: String },
  priceMonthly: { type: Number },
  priceYearly: { type: Number },
  currency: { type: String },
  status: { type: String },
  limits: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

module.exports = mongoose.models.Plan || mongoose.model('Plan', schema);
