'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');
const express = require('express');
const { reportingPeriod, scopeForRequest, summarize, csv } = require('../src/tenant/services/ownerReportSummary.service');
const approvedReportsRoutes = require('../src/tenant/routes/approvedReports.routes');
const { tenantMenu } = require('../src/services/menu.service');
const { tenantDbNameFromSlug } = require('../src/config/tenantDatabaseName');
const { entitledTenant } = require('./helpers/entitlement');

const owner = { role: 'Tenant Owner', permissions: ['*'] };
const analyst = { role: 'Reports Analyst', permissions: ['reports.view', 'reports.export'], allowedModules: ['reports'] };
const slug = 'summary-unit';
const dbName = tenantDbNameFromSlug(slug);
const subscribed = entitledTenant({ slug, dbName, plan: 'enterprise', enabledModules: ['reports'] });
const branches = [
  { _id: '507f1f77bcf86cd799439011', name: 'Main', timeZone: 'Africa/Kampala' },
  { _id: '507f1f77bcf86cd799439012', name: 'Second', timeZone: 'Africa/Juba' }
];

test('summary periods use local calendar days, including Monday and inclusive custom dates', () => {
  const now = new Date('2026-11-22T21:30:00.000Z');
  const week = reportingPeriod({ period: 'week' }, 'Africa/Kampala', now);
  assert.deepEqual(week.filter, { today: '2026-11-23', period: 'week', from: '2026-11-23', to: '2026-11-23' });
  assert.deepEqual(week.dateRange, {
    $gte: new Date('2026-11-22T21:00:00.000Z'), $lt: new Date('2026-11-23T21:00:00.000Z')
  });
  const month = reportingPeriod({ period: 'month' }, 'Africa/Juba', now);
  assert.equal(month.filter.from, '2026-11-01');
  assert.equal(month.filter.to, '2026-11-22');
  const day = reportingPeriod({}, 'Africa/Juba', now);
  assert.equal(day.filter.from, '2026-11-22');
  assert.equal(day.filter.to, '2026-11-22');
  const custom = reportingPeriod({ period: 'custom', from: '2026-03-07', to: '2026-03-08' }, 'America/New_York', now);
  assert.deepEqual(custom.dateRange, {
    $gte: new Date('2026-03-07T05:00:00.000Z'), $lt: new Date('2026-03-09T04:00:00.000Z')
  });
});

test('summary rejects invalid ranges and never returns bounds on an invalid filter', () => {
  const now = new Date('2026-11-24T12:00:00.000Z');
  for (const query of [
    { period: ['day', 'week'] }, { period: 'all' }, { period: 'custom' },
    { period: 'custom', from: '2026-02-29', to: '2026-03-01' },
    { period: 'custom', from: '2026-05-15', to: '2026-05-14' },
    { period: 'custom', from: '2026-11-25', to: '2026-11-25' },
    { period: 'custom', from: '2025-11-22', to: '2026-11-24' }
  ]) {
    const result = reportingPeriod(query, 'Africa/Kampala', now);
    assert.equal(result.dateRange, undefined);
    assert.ok(result.formError, JSON.stringify(query));
  }
  assert.ok(reportingPeriod({ period: 'custom', from: '2025-11-24', to: '2026-11-24' }, 'Africa/Kampala', now).dateRange);
});

test('summary uses the authorized viewing branch and one disclosed calendar for all branches', () => {
  const local = scopeForRequest({
    user: { ...owner, viewBranchId: branches[1]._id }, viewBranch: branches[1], operationBranch: branches[0]
  }, branches);
  assert.equal(String(local.scope.branchId), branches[1]._id);
  assert.equal(local.branchName, 'Second');
  assert.equal(local.timeZone, 'Africa/Juba');
  assert.throws(() => scopeForRequest({ user: { ...owner, viewBranchId: branches[1]._id }, viewBranch: branches[0] }), { status: 403 });

  const user = { ...owner, viewBranchId: 'all' };
  const all = scopeForRequest({ user, operationBranch: branches[0] }, branches);
  assert.deepEqual(all.scope, {});
  assert.equal(all.branch, null);
  assert.equal(all.timeZone, 'Africa/Kampala');
  assert.equal(all.branchName, 'All branches');
  assert.equal(all.allBranches, true);
  assert.equal(scopeForRequest({ user }, [branches[1]]).timeZone, 'Africa/Juba');
});

test('summary joins its currency and module rows and exports each exact amount separately', () => {
  assert.deepEqual(summarize(
    { totalCount: 0, byCurrency: [], byModule: [] }, { byCurrency: [], byModule: [] }
  ), { totalCount: 0, byCurrency: [], byModule: [] });
  const transactions = [
    { currency: 'UGX', count: 1, amountMinor: '20000' },
    { currency: 'USD', count: 1, amountMinor: '500' }
  ];
  const earnings = [
    { currency: 'UGX', incomeMinor: '120', expenseMinor: '10', netMinor: '110' },
    { currency: 'KES', incomeMinor: '0', expenseMinor: '913', netMinor: '-913' }
  ];
  const report = summarize({
    totalCount: 1, byCurrency: transactions,
    byModule: transactions.map(row => ({ moduleKey: 'mobile_money', ...row }))
  }, {
    byCurrency: earnings, byModule: [
      { moduleKey: 'mobile_money', ...earnings[0] }, { moduleKey: 'expenses', ...earnings[1] }
    ]
  });
  assert.equal(report.totalCount, 1);
  assert.deepEqual(report.byCurrency[0], { ...transactions[0], ...earnings[0] });
  assert.equal(report.byCurrency[1].netMinor, null);
  assert.equal(report.byCurrency[2].count, null);
  assert.equal(report.byModule[2].moduleLabel, 'Expenses');
  const exported = csv({
    ...report, from: '2026-11-24', to: '2026-11-24', branchName: '=danger', timeZone: 'Africa/Kampala'
  });
  assert.match(exported, /"'=danger"/);
  assert.match(exported, /"All modules \(distinct transactions\)","","1","","","",""/);
  assert.match(exported, /"Mobile Money","USD","1","5\.00","","",""/);
  assert.match(exported, /"Expenses","KES","","","0\.00","9\.13","-9\.13"/);
});

test('only a subscribed owner can reach the summary and CSV, including through direct URLs', async t => {
  const href = '/tenant/reports/summary';
  const visible = (tenant, user, path) => tenantMenu(tenant, user).flatMap(group => group.items).some(item => item.href === path);
  const expired = { ...subscribed, enabledModules: [] };
  assert.equal(visible(subscribed, owner, '/tenant/reports'), true);
  assert.equal(visible(expired, owner, '/tenant/reports'), false);
  assert.equal(visible(subscribed, analyst, '/tenant/reports'), true);
  assert.equal(visible(subscribed, owner, href), false);
  assert.ok(tenantMenu(subscribed, owner).some(group => group.paths.includes(href)));
  assert.ok(!tenantMenu(subscribed, analyst).some(group => group.paths.includes(href)));

  const app = express();
  app.use((req, res, next) => {
    const actor = req.get('x-fixture-actor');
    req.user = actor === 'analyst' ? analyst : actor === 'view-only' ? { ...owner, permissions: ['reports.view'] } : owner;
    req.tenant = actor === 'unsubscribed' ? expired : subscribed;
    req.tenantDb = { name: dbName };
    next();
  });
  app.use('/tenant', approvedReportsRoutes({
    renderTenant: (req, res, view, title, subtitle, data) => res.json({ view, formError: data.formError, canExport: data.canExport })
  }));
  app.use((error, req, res, next) => res.status(error.status || 500).send(error.message));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (path, actor) => fetch('http://127.0.0.1:' + server.address().port + path, {
    headers: { 'x-fixture-actor': actor }
  });
  for (const path of [href, href + '/export.csv']) {
    for (const actor of ['analyst', 'unsubscribed']) assert.equal((await request(path, actor)).status, 403);
  }
  assert.equal((await request(href + '/export.csv', 'view-only')).status, 403);
  const page = await request(href + '?period=custom', 'owner');
  assert.equal(page.status, 400);
  assert.deepEqual(await page.json(), { view: 'reports/summary', formError: 'Enter a valid start and end date.', canExport: false });
  assert.equal((await request(href + '/export.csv?period=custom', 'owner')).status, 400);
});

test('General reports opens with exact owner totals and loads legacy activity only on request', async t => {
  const summary = require('../src/tenant/services/ownerReportSummary.service');
  const operations = require('../src/tenant/services/operationsReports.service');
  const finance = require('../src/tenant/services/financeOverview.service');
  const cashDrawer = require('../src/tenant/services/cashDrawer.service');
  const entry = { currency: 'KES', count: 1, amountMinor: '1234', incomeMinor: '0', expenseMinor: '5', netMinor: '-5' };
  const now = new Date('2026-11-25T19:00:00Z');
  const ownerReads = [];
  const activityReads = [];
  const assets = [
    { currency: 'UGX', formatted: 'UGX 7,000' },
    { currency: 'KES', formatted: 'KES 42.50' }
  ];
  t.mock.method(summary, 'generate', async (req, branchRows, query) => {
    ownerReads.push(req.user.role);
    const context = scopeForRequest(req, branchRows);
    const { filter, formError } = reportingPeriod(query, context.timeZone, now);
    return {
      report: { ...context, ...filter, ...(!formError ? { totalCount: 1, byCurrency: [entry], byModule: [] } : {}) },
      formError
    };
  });
  t.mock.method(finance, 'overview', async (_conn, _tenant, user, options) => {
    assert.equal(options.includeEarnings, user.role !== 'Tenant Owner');
    assert.equal(options.scopeToAssignedModules, true);
    assert.equal(options.includeAccounts, true);
    return user.role === 'Tenant Owner' ? { available: true, bookAssets: assets, bookCash: [assets[1]] } : { available: false };
  });
  t.mock.method(cashDrawer, 'expectedCash', async () => []);
  t.mock.method(operations, 'generate', async (_conn, tenant, user, query, timeZone) => {
    const sources = operations.sourcesFor(tenant, user);
    const filters = operations.parseFilters(query, sources, timeZone);
    activityReads.push({ from: filters.from, to: filters.to, source: filters.source });
    return { rows: [{ module: 'Workspace', activity: 'Cash count saved' }], filters, sources };
  });
  const app = express();
  app.use((req, res, next) => {
    req.tenant = subscribed;
    req.tenantDb = { name: dbName };
    req.viewBranch = branches[1];
    req.viewBranchId = branches[1]._id;
    req.operationBranch = branches[0];
    req.user = req.get('x-fixture-actor') === 'analyst' ? analyst : { ...owner, viewBranchId: branches[1]._id };
    res.locals.viewBranches = branches;
    next();
  });
  app.use('/tenant', approvedReportsRoutes({
    renderTenant: (_req, res, view, _title, _subtitle, data) => res.json({ view, ...data })
  }));
  app.use((error, req, res, next) => res.status(error.status || 500).send(error.message));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = (query, actor = 'owner') => fetch(`http://127.0.0.1:${server.address().port}/tenant/reports${query}`, {
    headers: { 'x-fixture-actor': actor }
  });
  const landing = await (await get('?period=week')).json();
  assert.equal(landing.businessSummary.report.branchName, 'Second');
  assert.deepEqual(landing.businessSummary.report.byCurrency, [entry]);
  assert.equal(landing.activityLoaded, false);
  assert.deepEqual(activityReads, []);
  assert.deepEqual(landing.fundsStats, [
    { currency: 'UGX', cash: null, float: null, assets: 'UGX 7,000' },
    { currency: 'KES', cash: 'KSH 42.50', float: null, assets: 'KSH 42.50' }
  ]);
  const detail = await (await get('?period=week&activity=1&source=workspace')).json();
  assert.equal(detail.activityLoaded, true);
  assert.deepEqual(activityReads.at(-1), { from: '2026-11-23', to: '2026-11-25', source: 'workspace' });
  const legacy = await (await get('?from=2026-11-19&to=2026-11-22')).json();
  assert.equal(legacy.businessSummary.report.period, 'custom');
  assert.equal(legacy.activityLoaded, true);
  assert.deepEqual(activityReads.at(-1), { from: '2026-11-19', to: '2026-11-22', source: 'all' });
  const long = await (await get('?period=custom&from=2026-01-01&to=2026-11-24&activity=1')).json();
  assert.equal(long.businessSummary.report.totalCount, 1);
  assert.equal(long.activityLoaded, false);
  assert.match(long.activityNotice, /within 90 days/);
  const invalid = await get('?period=custom');
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).businessSummary.formError, /valid start and end date/);
  assert.equal((await get('?period=week&activity=1&source=mobile_money')).status, 403);
  const beforeStaff = ownerReads.length;
  const staff = await (await get('?from=2026-11-19&to=2026-11-22', 'analyst')).json();
  assert.equal(staff.activityLoaded, true);
  assert.equal(staff.businessSummary, undefined);
  assert.equal(staff.fundsStats, undefined);
  assert.equal(ownerReads.length, beforeStaff);
});
