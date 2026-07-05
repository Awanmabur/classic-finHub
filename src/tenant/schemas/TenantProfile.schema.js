const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  name: { type: mongoose.Schema.Types.Mixed },
  logo: { type: mongoose.Schema.Types.Mixed },
  defaultCurrency: { type: mongoose.Schema.Types.Mixed },
  currencies: { type: mongoose.Schema.Types.Mixed },
  contactEmail: { type: mongoose.Schema.Types.Mixed },
  contactPhone: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
