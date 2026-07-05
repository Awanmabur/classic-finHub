const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.Mixed },
  receiverName: { type: mongoose.Schema.Types.Mixed },
  receiverPhone: { type: mongoose.Schema.Types.Mixed },
  amount: { type: mongoose.Schema.Types.Mixed },
  currency: { type: mongoose.Schema.Types.Mixed },
  fee: { type: mongoose.Schema.Types.Mixed },
  pinHash: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed },
  reference: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
