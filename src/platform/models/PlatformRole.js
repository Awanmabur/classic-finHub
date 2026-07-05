const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  name: { type: String },
  permissions: { type: mongoose.Schema.Types.Mixed },
  status: { type: String }
}, { timestamps: true });

module.exports = mongoose.models.PlatformRole || mongoose.model('PlatformRole', schema);
