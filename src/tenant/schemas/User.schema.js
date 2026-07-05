const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  name: { type: mongoose.Schema.Types.Mixed },
  email: { type: mongoose.Schema.Types.Mixed },
  phone: { type: mongoose.Schema.Types.Mixed },
  passwordHash: { type: mongoose.Schema.Types.Mixed },
  roleId: { type: mongoose.Schema.Types.Mixed },
  branchId: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed },
  permissions: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
