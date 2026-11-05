'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  count: { type: Number, min: 0, required: true, default: 0 },
  expiresAt: { type: Date, required: true }
}, { versionKey: false, strict: 'throw' });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.models.LoginThrottle || mongoose.model('LoginThrottle', schema);
