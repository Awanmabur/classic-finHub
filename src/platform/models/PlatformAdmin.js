const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  name: { type: String },
  email: { type: String },
  passwordHash: { type: String },
  role: { type: String },
  status: { type: String }
}, { timestamps: true });

module.exports = mongoose.models.PlatformAdmin || mongoose.model('PlatformAdmin', schema);
