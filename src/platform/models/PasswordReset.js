'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  identityId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true, index: true },
  tokenHash: { type: String, required: true, unique: true, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
  createdAt: { type: Date, default: Date.now, immutable: true }
}, { strict: 'throw', versionKey: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.models.PasswordReset || mongoose.model('PasswordReset', schema);
