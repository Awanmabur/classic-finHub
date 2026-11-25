'use strict';

const { Types } = require('mongoose');
const { currencyCodes } = require('../../config/currencies');
const { tenantDbNameFromSlug } = require('../../config/tenantDatabaseName');
const { expenseModel } = require('../models/expenses');
const { branchMatch } = require('../reporting/aggregateScope');
const { readScope } = require('./branchView.service');
const { canUse } = require('./moduleAccess.service');
const {
  aggregateLegs, fail, moduleGroups, postedActivityJobs, sources, totalFor
} = require('./dashboardVolumes.service');

const maxTimeMS = 10000;
const core = Object.keys(sources);
const retail = ['expenses', 'loans', 'airtime'];

function authorizedScope(conn, tenant, actor, branch, scope) {
  if (actor?.role !== 'Tenant Owner' || !canUse(tenant, actor, 'reports', 'reports.view'))
    throw fail('Owner summary access is unavailable', 403);
  if (!tenant.slug || conn?.name !== tenant.dbName || conn.name !== tenantDbNameFromSlug(tenant.slug))
    throw fail('Tenant database context mismatch', 403);

  const selected = readScope(actor);
  const requested = scope?.branchId ?? branch?._id;
  if (selected.branchId && requested && String(selected.branchId) !== String(requested))
    throw fail('The selected viewing branch is unavailable', 403);

  return branchMatch({ branchId: selected.branchId ?? requested }, id => new Types.ObjectId(id));
}

function excludeReversals(Model, foreignField) {
  return [
    { $lookup: { from: Model.collection.name, localField: '_id', foreignField, as: 'reversal' } },
    { $match: { 'reversal.0': { $exists: false } } }
  ];
}

function singleCurrency(Model, match, amount, stages = []) {
  return aggregateLegs(Model, match, [{ currency: '$currency', amount }], { maxTimeMS, stages });
}

function retailActivityJobs(conn, tenant, scope, dateRange) {
  const branchAndTenant = { ...scope, tenantId: new Types.ObjectId(String(tenant._id)) };
  const { loan, payment, correction: loanCorrection } = require('../retailFinance/loans.models').models(conn);
  const { record, correction: airtimeCorrection } = require('../retailFinance/airtime.models').models(conn);

  return [
    ['expenses', () => singleCurrency(expenseModel(conn), {
      ...scope, status: 'approved', reviewedAt: dateRange
    }, '$amountMinor')],
    ['loans', () => singleCurrency(loan, {
      ...branchAndTenant, status: { $in: ['active', 'paid'] }, disbursedAt: dateRange,
      disbursementBatchId: { $type: 'objectId' }
    }, '$principalMinor')],
    ['loans', () => singleCurrency(payment, { ...branchAndTenant, createdAt: dateRange },
      '$amountMinor', excludeReversals(loanCorrection, 'paymentId'))],
    ['airtime', () => singleCurrency(record, {
      ...branchAndTenant, type: { $in: ['stock_purchase', 'sale'] }, createdAt: dateRange
    }, { $cond: [{ $eq: ['$type', 'sale'] }, '$retailMinor', '$costMinor'] },
    excludeReversals(airtimeCorrection, 'recordId'))]
  ];
}

function currencyRows(groups) {
  return currencyCodes.flatMap(currency => {
    const { count, amountMinor } = totalFor(groups, currency);
    return count ? [{ currency, count, amountMinor }] : [];
  });
}

async function activity(conn, tenant, actor, { branch, scope, dateRange } = {}) {
  const branchScope = authorizedScope(conn, tenant, actor, branch, scope);
  const { $gte, $lt } = dateRange ?? {};
  if (!($gte instanceof Date && $lt instanceof Date && $gte < $lt))
    throw fail('Choose a valid reporting period');
  const dates = { $gte, $lt };
  // Owners can read their branch-scoped financial history even after removing
  // a module. The reports permission grants no module or posting actions.
  const jobs = [
    ...postedActivityJobs(conn, tenant, actor, {
      enabled: core, scope: branchScope, dateRange: dates, maxTimeMS,
      includeInternalBanking: true, includeLegacyRecords: true
    }),
    ...retailActivityJobs(conn, tenant, branchScope, dates)
  ];
  const parts = await Promise.all(jobs.map(async ([key, read]) => [key, await read()]));

  // Currency totals use original records only. The Forex module also shows the
  // currency legs of cross-currency transactions booked by other modules.
  return {
    totalCount: parts.reduce((count, [, data]) => count + data.count, 0),
    byCurrency: currencyRows(parts.flatMap(([, data]) => data.groups)),
    byModule: [...core, ...retail].flatMap(moduleKey =>
      currencyRows(moduleGroups(parts, moduleKey)).map(row => ({ moduleKey, ...row })))
  };
}

module.exports = { activity };
