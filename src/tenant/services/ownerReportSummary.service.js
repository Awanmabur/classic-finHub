'use strict';

const businessTime = require('../../utils/businessTime');
const { forexCurrencyCodes } = require('../../config/currencies');
const { tenantDbNameFromSlug } = require('../../config/tenantDatabaseName');
const { canUse } = require('./moduleAccess.service');
const { readScope } = require('./branchView.service');
const { activity } = require('./ownerReportActivity.service');
const { earnings } = require('./ownerReportEarnings.service');
const { amountLabel } = require('./forex.service');
const { csvCell } = require('./mobileMoney.service');

const moduleLabels = {
  mobile_money: 'Mobile Money',
  money_transfer: 'Money Transfer',
  banking: 'Banking',
  forex: 'Forex',
  loans: 'Loans',
  airtime: 'Airtime',
  expenses: 'Expenses',
  unattributed: 'Unattributed earnings'
};
const periods = ['day', 'week', 'month', 'custom'];

function scopeForRequest(req, branches = []) {
  const scope = readScope(req.user);
  const allBranches = !scope.branchId;
  const branch = allBranches ? null : req.viewBranch;
  if (!allBranches && String(scope.branchId) !== String(branch?._id))
    throw Object.assign(new Error('The selected viewing branch is unavailable'), { status: 403 });

  const branchZones = allBranches ? new Set(branches.map(businessTime.forBranch)) : new Set();
  const timeZone = branchZones.size === 1 ? [...branchZones][0] :
    businessTime.forBranch(allBranches ? req.operationBranch : branch);
  return { branch, scope, allBranches, timeZone, branchName: allBranches ? 'All branches' : branch.name };
}

function reportingPeriod(query, timeZone, now = new Date()) {
  const today = businessTime.localDay(now, timeZone);
  const period = query.period ?? 'day';
  const filter = { today, period: periods.includes(period) ? period : 'day', from: today, to: today };
  if (!periods.includes(period))
    return { filter, formError: 'Choose Today, This week, This month or a custom date range.' };

  if (period === 'week') {
    const dayOfWeek = businessTime.parseDay(today).getUTCDay();
    filter.from = businessTime.addDays(today, -((dayOfWeek + 6) % 7));
  }
  if (period === 'month') filter.from = today.slice(0, 8) + '01';
  if (period === 'custom') {
    const calendarDate = date => {
      try { businessTime.parseDay(date); return date; } catch { return ''; }
    };
    filter.from = calendarDate(query.from);
    filter.to = calendarDate(query.to);
    if (!filter.from || !filter.to)
      return { filter, formError: 'Enter a valid start and end date.' };
    if (filter.to > today)
      return { filter, formError: 'Choose an end date of today or earlier.' };
    if (filter.from > filter.to)
      return { filter, formError: 'The start date must be on or before the end date.' };
  }

  try {
    const { $gte, $lt } = businessTime.dayBounds(filter, timeZone, 365, now);
    return { filter, dateRange: { $gte, $lt } };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { filter, formError: 'Choose a date range of 366 days or fewer.' };
  }
}

function combineRows(transactions, postings, key) {
  const rows = new Map();
  for (const row of [...transactions, ...postings]) {
    const id = key(row);
    rows.set(id, {
      count: null, amountMinor: null, incomeMinor: null, expenseMinor: null, netMinor: null,
      ...rows.get(id), ...row
    });
  }
  return [...rows.values()];
}

function summarize(transactions, postings) {
  const byCurrency = combineRows(transactions.byCurrency, postings.byCurrency, row => row.currency);
  const byModule = combineRows(transactions.byModule, postings.byModule, row => row.moduleKey + ':' + row.currency);
  const currencyOrder = (a, b) => forexCurrencyCodes.indexOf(a.currency) - forexCurrencyCodes.indexOf(b.currency);
  const moduleOrder = Object.keys(moduleLabels);
  return {
    totalCount: transactions.totalCount,
    byCurrency: byCurrency.sort(currencyOrder),
    byModule: byModule.sort((a, b) =>
      moduleOrder.indexOf(a.moduleKey) - moduleOrder.indexOf(b.moduleKey) || currencyOrder(a, b)
    ).map(row => ({ ...row, moduleLabel: moduleLabels[row.moduleKey] ?? row.moduleKey }))
  };
}

async function generate(req, branches) {
  if (req.user?.role !== 'Tenant Owner' || !canUse(req.tenant, req.user, 'reports', 'reports.view'))
    throw Object.assign(new Error('Business summary is available to the tenant owner.'), { status: 403 });
  const dbName = req.tenantDb?.name;
  if (!dbName || dbName !== req.tenant.dbName || !req.tenant.slug || dbName !== tenantDbNameFromSlug(req.tenant.slug))
    throw Object.assign(new Error('Tenant database context mismatch'), { status: 403 });

  const { branch, scope, ...context } = scopeForRequest(req, branches);
  const { filter, formError, dateRange } = reportingPeriod(req.query, context.timeZone);
  const report = { ...filter, ...context };
  if (formError) return { report, formError };

  const [transactions, postings] = await Promise.all([
    activity(req.tenantDb, req.tenant, req.user, { branch, scope, dateRange }),
    earnings(req.tenantDb, req.tenant, scope, dateRange)
  ]);
  return { report: { ...report, ...summarize(transactions, postings) } };
}

function csv(report) {
  const context = [report.from, report.to, report.branchName, report.timeZone];
  const amount = (row, key) => row[key] == null ? '' :
    amountLabel(row[key], row.currency).slice(row.currency.length + 1).replaceAll(',', '');
  const breakdown = (row, module) => [
    ...context, module, row.currency, row.count, ...['amountMinor', 'incomeMinor', 'expenseMinor', 'netMinor'].map(key => amount(row, key))
  ];
  const rows = [
    ['From', 'To', 'Branch', 'Time zone', 'Module', 'Currency', 'Recorded transaction count',
      'Transaction amount', 'Posted income', 'Posted expenses', 'Posted profit'],
    [...context, 'All modules (distinct transactions)', '', report.totalCount, '', '', '', ''],
    ...report.byCurrency.map(row => breakdown(row, 'All modules')),
    ...report.byModule.map(row => breakdown(row, row.moduleLabel))
  ];
  return '\uFEFF' + rows.map(values => values.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { generate, scopeForRequest, reportingPeriod, summarize, csv };
