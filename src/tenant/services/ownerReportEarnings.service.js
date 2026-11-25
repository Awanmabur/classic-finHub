'use strict';

const { Types } = require('mongoose');
const { currencyCodes } = require('../../config/currencies');
const { ledgerAccountModel, ledgerJournalModel, ledgerPostingModel } = require('../models');
const { models: fundsModels } = require('../treasury/models');
const { models: fundedModels } = require('../funded/models');

const modules = ['mobile_money', 'money_transfer', 'banking', 'forex', 'expenses', 'loans', 'airtime'];

function summarize(groups) {
  const byModule = new Map();
  const byCurrency = new Map();
  for (const { _id, amountMinor } of groups) {
    const { moduleKey, currency, category, side } = _id;
    const normalSide = category === 'income' ? 'credit' : 'debit';
    const minor = BigInt(String(amountMinor)) * (side === normalSide ? 1n : -1n);
    const moduleCurrency = `${moduleKey}:${currency}`;
    if (!byModule.has(moduleCurrency)) {
      byModule.set(moduleCurrency, { moduleKey, currency, income: 0n, expense: 0n });
    }
    if (!byCurrency.has(currency)) {
      byCurrency.set(currency, { currency, income: 0n, expense: 0n });
    }
    byModule.get(moduleCurrency)[category] += minor;
    byCurrency.get(currency)[category] += minor;
  }
  const rows = map => [...map.values()].map(({ income, expense, ...row }) => ({
    ...row,
    incomeMinor: String(income),
    expenseMinor: String(expense),
    netMinor: String(income - expense)
  }));
  return { byModule: rows(byModule), byCurrency: rows(byCurrency) };
}

async function earnings(conn, tenant, scope, dateRange) {
  const Account = ledgerAccountModel(conn);
  const Posting = ledgerPostingModel(conn);
  const Journal = ledgerJournalModel(conn);
  const { batch: Batch } = fundsModels(conn);
  const { execution: Execution } = fundedModels(conn);
  const tenantId = new Types.ObjectId(String(tenant._id));
  const branchFilter = scope.branchId ? { branchId: new Types.ObjectId(String(scope.branchId)) } : {};

  // The posting date records when the earnings entered the ledger, including
  // reversals. Starting at income and expense accounts avoids reading every
  // cash, float, capital or stock movement in the selected period.
  const groups = await Account.aggregate([
    { $match: { ...branchFilter, category: { $in: ['income', 'expense'] }, currency: { $in: currencyCodes } } },
    { $lookup: {
      from: Posting.collection.name,
      let: { branchId: '$branchId', accountId: '$_id', currency: '$currency' },
      pipeline: [
        { $match: { createdAt: dateRange, $expr: { $and: [
          { $eq: ['$branchId', '$$branchId'] },
          { $eq: ['$accountId', '$$accountId'] },
          { $eq: ['$currency', '$$currency'] }
        ] } } },
        { $project: { _id: 0, journalId: 1, side: 1, amountMinor: 1 } }
      ],
      as: 'posting'
    } },
    { $unwind: '$posting' },
    { $group: {
      _id: {
        journalId: '$posting.journalId', branchId: '$branchId', currency: '$currency',
        category: '$category', side: '$posting.side'
      },
      amountMinor: { $sum: '$posting.amountMinor' }
    } },
    { $lookup: { from: Journal.collection.name, localField: '_id.journalId', foreignField: '_id', as: 'journal' } },
    { $unwind: '$journal' },
    { $match: { $expr: { $and: [
      { $eq: ['$journal.branchId', '$_id.branchId'] },
      { $eq: ['$journal.currency', '$_id.currency'] }
    ] } } },
    { $lookup: {
      from: Journal.collection.name, localField: 'journal.reverses', foreignField: '_id',
      let: { branchId: '$_id.branchId', currency: '$_id.currency' },
      pipeline: [{ $match: { $expr: { $and: [
        { $eq: ['$branchId', '$$branchId'] },
        { $eq: ['$currency', '$$currency'] }
      ] } } }],
      as: 'originalJournal'
    } },
    { $set: { source: { $cond: [
      { $eq: ['$journal.sourceType', 'reversal'] }, { $first: '$originalJournal' }, '$journal'
    ] } } },
    // Operational journals carry their Treasury batch ID in TRS:<id>:<currency>.
    // Verify the reverse link before attributing anything. Opening controls and
    // interbranch clearing journals use other references and have no P&L lines.
    { $set: { batchId: { $cond: [
      { $and: [
        { $eq: ['$source.sourceType', 'treasury'] },
        { $regexMatch: { input: { $ifNull: ['$source.sourceRef', ''] }, regex: /^TRS:[a-f0-9]{24}:[A-Z]{3}$/ } }
      ] },
      { $toObjectId: { $substrBytes: ['$source.sourceRef', 4, 24] } },
      null
    ] } } },
    { $lookup: {
      from: Batch.collection.name, localField: 'batchId', foreignField: '_id',
      let: { branchId: '$_id.branchId', journalId: '$source._id' },
      pipeline: [{ $match: { tenantId, $expr: { $and: [
        { $eq: ['$branchId', '$$branchId'] },
        { $in: ['$$journalId', { $ifNull: ['$journalIds', []] }] }
      ] } } }],
      as: 'batch'
    } },
    { $set: { batch: { $first: '$batch' } } },
    { $lookup: {
      from: Batch.collection.name, localField: 'batch.reversesBatchId', foreignField: '_id',
      let: { branchId: '$_id.branchId' },
      pipeline: [{ $match: { tenantId, $expr: { $eq: ['$branchId', '$$branchId'] } } }],
      as: 'originalBatch'
    } },
    { $set: { source: { $cond: [
      { $eq: ['$source.sourceType', 'treasury'] },
      { $cond: [{ $ifNull: ['$batch.reversesBatchId', false] }, { $first: '$originalBatch' }, '$batch'] },
      '$source'
    ] } } },
    { $set: {
      sourceRef: { $ifNull: ['$source.sourceRef', ''] },
      treasuryForex: { $and: [
        { $eq: ['$journal.sourceType', 'treasury'] },
        { $eq: ['$source.sourceType', 'forex'] }
      ] }
    } },
    // Native Forex trades use the same FUNDED:<id> convention, so the
    // execution must confirm a cross-currency remittance payout.
    { $set: { executionId: { $cond: [
      { $and: ['$treasuryForex', { $regexMatch: { input: '$sourceRef', regex: /^FUNDED:[a-f0-9]{24}$/ } }] },
      { $toObjectId: { $substrBytes: ['$sourceRef', 7, 24] } },
      null
    ] } } },
    { $lookup: {
      from: Execution.collection.name, localField: 'executionId', foreignField: '_id',
      let: { branchId: '$_id.branchId', batchJournalIds: '$source.journalIds' },
      pipeline: [{ $match: {
        sourceType: 'money_transfer', action: 'transfer_payout', status: 'posted_manual',
        'payoutFx.targetCurrency': { $exists: true },
        $expr: { $and: [
          { $eq: ['$branchId', '$$branchId'] },
          { $gt: [{ $size: { $setIntersection: [
            { $ifNull: ['$journalIds', []] }, { $ifNull: ['$$batchJournalIds', []] }
          ] } }, 0] }
        ] }
      } }],
      as: 'remittance'
    } },
    { $set: { moduleKey: { $switch: {
      branches: [
        { case: { $and: ['$treasuryForex', { $regexMatch: { input: '$sourceRef', regex: /^(MFX:|MM-VOID:)/ } }] }, then: 'mobile_money' },
        { case: { $and: ['$treasuryForex', { $regexMatch: { input: '$sourceRef', regex: /^BANKFX:/ } }] }, then: 'banking' },
        { case: { $gt: [{ $size: '$remittance' }, 0] }, then: 'money_transfer' },
        { case: { $in: [{ $ifNull: ['$source.sourceType', ''] }, modules] }, then: '$source.sourceType' }
      ],
      default: 'unattributed'
    } } } },
    { $group: {
      _id: { moduleKey: '$moduleKey', currency: '$_id.currency', category: '$_id.category', side: '$_id.side' },
      amountMinor: { $sum: '$amountMinor' }
    } },
    { $sort: { '_id.currency': 1, '_id.moduleKey': 1 } }
  ]).option({ allowDiskUse: true, maxTimeMS: 10000 });

  return summarize(groups);
}

module.exports = { earnings };
