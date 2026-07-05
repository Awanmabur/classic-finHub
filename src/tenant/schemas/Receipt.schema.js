const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  receiptNumber: { type: mongoose.Schema.Types.Mixed },
  moduleKey: { type: mongoose.Schema.Types.Mixed },
  transactionId: { type: mongoose.Schema.Types.Mixed },
  customerName: { type: mongoose.Schema.Types.Mixed },
  amount: { type: mongoose.Schema.Types.Mixed },
  currency: { type: mongoose.Schema.Types.Mixed },
  fee: { type: mongoose.Schema.Types.Mixed },
  pdfPath: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
