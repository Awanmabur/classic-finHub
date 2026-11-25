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
  const visible = (tenant, user) => tenantMenu(tenant, user).flatMap(group => group.items).some(item => item.href === href);
  const expired = { ...subscribed, enabledModules: [] };
  assert.equal(visible(subscribed, owner), true);
  assert.equal(visible(expired, owner), false);
  assert.equal(visible(subscribed, analyst), false);

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
