const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
  heroTitle: { type: mongoose.Schema.Types.Mixed },
  services: { type: mongoose.Schema.Types.Mixed },
  contact: { type: mongoose.Schema.Types.Mixed },
  seo: { type: mongoose.Schema.Types.Mixed },
  customCss: { type: mongoose.Schema.Types.Mixed },
  domain: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
