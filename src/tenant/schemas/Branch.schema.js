const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  name: { type: mongoose.Schema.Types.Mixed },
  code: { type: mongoose.Schema.Types.Mixed },
  address: { type: mongoose.Schema.Types.Mixed },
  status: { type: mongoose.Schema.Types.Mixed },
  currencies: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
