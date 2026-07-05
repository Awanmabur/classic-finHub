const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  tenantId: { type: String },
  number: { type: String },
  amount: { type: Number },
  currency: { type: String },
  status: { type: String },
  dueDate: { type: Date }
}, { timestamps: true });

module.exports = mongoose.models.Invoice || mongoose.model('Invoice', schema);
