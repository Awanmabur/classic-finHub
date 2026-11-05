const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 120 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  authVersion: { type: Number, min: 0, default: 0, required: true },
  mfaSecretEncrypted: { type: String, default: null, select: false },
  mfaEnabledAt: { type: Date, default: null },
  mfaLastCounter: { type: Number, min: -1, default: -1 },
  role: { type: String, enum: ['Super Admin'], required: true },
  status: { type: String, enum: ['active','disabled'], default: 'active' }
}, { timestamps: true, strict: 'throw' });
module.exports = mongoose.models.PlatformAdmin || mongoose.model('PlatformAdmin', schema);
