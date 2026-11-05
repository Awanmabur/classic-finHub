'use strict';
const mongoose = require('mongoose');

// A platform-wide email directory is required to route a user without asking
// for their tenant. No credential or password hash is stored in this directory.
// A person who needs access to more than one tenant must use distinct emails;
// do not silently pick a tenant or fall back to a demo account.
const schema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true,
    maxlength: 254, immutable: true },
  kind: { type: String, enum: ['platform', 'tenant'], required: true, immutable: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  tenantId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true }
}, { timestamps: true, strict: 'throw' });
schema.index({ kind: 1, accountId: 1 }, { unique: true });
schema.pre('validate', function(next) {
  if ((this.kind === 'tenant') !== Boolean(this.tenantId)) return next(new Error('Invalid identity-to-tenant mapping'));
  next();
});
module.exports = mongoose.models.AccountIdentity || mongoose.model('AccountIdentity', schema);
