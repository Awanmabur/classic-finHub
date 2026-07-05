const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  moduleKey: { type: String },
  name: { type: String },
  priceMonthly: { type: Number },
  status: { type: String }
}, { timestamps: true });

module.exports = mongoose.models.ModuleAddon || mongoose.model('ModuleAddon', schema);
