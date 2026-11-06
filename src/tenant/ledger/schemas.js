'use strict';
const mongoose = require('mongoose');
const {currencyCodes}=require('../../config/currencies');
const { Schema } = mongoose;

// The general banking Account model and legacy LedgerEntry schema are NOT accounting
// source-of-truth. These models deliberately use separate collection names.
function appendOnly(schema) {
  schema.set('strict', 'throw');
  schema.set('versionKey', false);
  schema.pre('save', function (next) {
    if (!this.isNew) return next(new Error('Ledger records are append-only'));
    next();
  });
  for (const op of ['updateOne', 'updateMany', 'replaceOne', 'findOneAndUpdate',
    'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
    schema.pre(op, function (next) { next(new Error('Ledger records are append-only')); });
  }
}
const account = new Schema({
  branchId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  code: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z][A-Z0-9_]{2,39}$/, immutable: true },
  name: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
  currency: { type: String, enum: currencyCodes, required: true, immutable: true },
  category: { type: String, enum: ['asset', 'liability', 'equity', 'income', 'expense'], required: true, immutable: true },
  createdBy: { type: Schema.Types.ObjectId, required: true, immutable: true },
  createdAt: { type: Date, default: Date.now, immutable: true }
});
appendOnly(account);
account.index({ branchId: 1, code: 1 }, { unique: true });
account.index({ branchId: 1, currency: 1, category: 1 });

const journal = new Schema({
  branchId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  currency: { type: String, enum: currencyCodes, required: true, immutable: true },
  sourceType: { type: String, enum: ['mobile_money', 'money_transfer', 'banking', 'forex', 'reversal'], required: true, immutable: true },
  sourceRef: { type: String, required: true, immutable: true, match: /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,119}$/ },
  fingerprint: { type: String, required: true, immutable: true, match: /^[0-9a-f]{64}$/ },
  reverses: { type: Schema.Types.ObjectId, default: null, immutable: true },
  approval: {
    requestedBy: { type: Schema.Types.ObjectId, immutable: true },
    approvedBy: { type: Schema.Types.ObjectId, immutable: true },
    reason: { type: String, immutable: true, maxlength: 400 },
    ticketRef: { type: String, immutable: true, maxlength: 100 }
  },
  actorId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  createdAt: { type: Date, default: Date.now, immutable: true }
});
appendOnly(journal);
journal.index({ sourceType: 1, sourceRef: 1 }, { unique: true });
journal.index({ reverses: 1 }, { unique: true, partialFilterExpression: { reverses: { $type: 'objectId' } } });
journal.index({ branchId: 1, createdAt: -1 });

const posting = new Schema({
  journalId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  branchId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  accountId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  currency: { type: String, enum: currencyCodes, required: true, immutable: true },
  lineNo: { type: Number, required: true, min: 0, max: 49, immutable: true },
  side: { type: String, enum: ['debit', 'credit'], required: true, immutable: true },
  amountMinor: { type: Schema.Types.Decimal128, required: true, immutable: true },
  createdAt: { type: Date, default: Date.now, immutable: true }
});
appendOnly(posting);
posting.index({ journalId: 1, lineNo: 1 }, { unique: true });
posting.index({ branchId: 1, accountId: 1, createdAt: -1 });
posting.index({ branchId: 1, currency: 1, createdAt: -1 });

module.exports = { account, journal, posting };
