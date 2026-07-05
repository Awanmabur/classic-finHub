const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  invoiceId: { type: String },
  amount: { type: Number },
  currency: { type: String },
  method: { type: String },
  status: { type: String },
  paidAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.models.Payment || mongoose.model('Payment', schema);
