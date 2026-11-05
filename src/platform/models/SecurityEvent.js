'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  action: { type: String, enum: ['auth.login.success','auth.login.failed','auth.login.password_validated','auth.mfa.enrolled','auth.mfa.verified','auth.mfa.failed','auth.password_reset.requested','auth.password_reset.completed','auth.admin.break_glass_recovery','auth.password_reset.notification_failed','auth.mfa.break_glass_reset'], required: true, immutable: true },
  subjectHash: { type: String, required: true, immutable: true },
  ipHash: { type: String, immutable: true },
  identityId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
  createdAt: { type: Date, default: Date.now, immutable: true }
}, { versionKey: false, strict: 'throw' });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
module.exports = mongoose.models.SecurityEvent || mongoose.model('SecurityEvent', schema);
