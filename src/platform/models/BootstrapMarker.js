'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, immutable: true }
}, { strict: 'throw', versionKey: false });
module.exports = mongoose.models.BootstrapMarker || mongoose.model('BootstrapMarker', schema);
