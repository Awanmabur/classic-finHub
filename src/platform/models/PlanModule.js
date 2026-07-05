const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  planId: { type: String },
  moduleKey: { type: String },
  included: { type: Boolean },
  limits: { type: mongoose.Schema.Types.Mixed },
  addonAllowed: { type: Boolean }
}, { timestamps: true });

module.exports = mongoose.models.PlanModule || mongoose.model('PlanModule', schema);
