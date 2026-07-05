const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  key: { type: String },
  name: { type: String },
  category: { type: String },
  description: { type: String },
  status: { type: String },
  isCore: { type: Boolean },
  dependencies: { type: mongoose.Schema.Types.Mixed },
  defaultPermissions: { type: mongoose.Schema.Types.Mixed },
  menuItems: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

module.exports = mongoose.models.Module || mongoose.model('Module', schema);
