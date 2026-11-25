'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const ejs = require('ejs');
const { amountLabel } = require('../src/tenant/services/forex.service');
const { currencyLabel } = require('../src/config/currencies');

const template = path.resolve(__dirname, '../src/views/tenant/reports/index.ejs');
const visiblePaths = new Set(['/tenant/reports', '/tenant/reports/transactions']);
const period = {
  period: 'day', from: '2026-11-25', to: '2026-11-25', today: '2026-11-25',
  branchName: 'Main', timeZone: 'Africa/Kampala'
};
const ugx = { currency: 'UGX', count: 1, amountMinor: '1000', netMinor: '150', incomeMinor: '200', expenseMinor: '50' };
const usd = { currency: 'USD', count: 1, amountMinor: '4999', netMinor: '-230', incomeMinor: '70', expenseMinor: '300' };
const ssp = { currency: 'SSP', count: 1, amountMinor: '1500', netMinor: null, incomeMinor: null, expenseMinor: null };
const operations = { filters: { from: period.from, to: period.to, source: 'all' }, sources: [], rows: [] };

function render(data) {
  return ejs.renderFile(template, { data, visiblePaths, currentPath: '/tenant/reports' });
}

function summary(report, extras = {}) {
  return { report: { ...period, ...report }, canExport: true, formatMoney: amountLabel, currencyLabel, ...extras };
}

test('General reports leads with distinct transactions and exact native profit and loss', async () => {
  const html = await render({ report: operations, businessSummary: summary({ totalCount: 2,
    byCurrency: [ugx, usd, ssp], byModule: [{ ...ugx, moduleLabel: 'Mobile Money' }, { ...usd, moduleLabel: 'Forex' }]
  }), fundsStats: [{ currency: 'UGX', cash: 'UGX 50,000', float: null, assets: 'UGX 60,000' }] });
  assert.match(html, /Main · 25 Nov 2026 · Africa\/Kampala/);
  assert.match(html, /<strong>2<\/strong><span>recorded transactions across all modules/);
  assert.match(html, /recap-UGX[\s\S]*?<span>Posted profit<\/span>\s*<strong>UGX 150<\/strong>/);
  assert.match(html, /recap-USD[\s\S]*?<span>Posted loss<\/span>\s*<strong>USD -2\.30<\/strong>/);
  assert.match(html, /recap-SSP[\s\S]*?<span>Posted profit \/ loss<\/span>\s*<strong>—<\/strong>/);
  assert.match(html, /By module and currency[\s\S]*?Income|By module and currency[\s\S]*?Posted income/);
  assert.match(html, /transactions\?from=2026-11-25&amp;to=2026-11-25/);
  assert.match(html, /summary\/export\.csv\?period=custom&amp;from=2026-11-25&amp;to=2026-11-25/);
  assert.match(html, /By module and currency[\s\S]*Current balances[\s\S]*UGX 50,000[\s\S]*Recorded activity/);
  assert.match(html, /<details class="card generalReportDetails" id="generalReportActivity">/);
  assert.match(html, /Load activity/);
  assert.doesNotMatch(html, /No activity for the selected source and dates/);
});

test('General reports exposes requested loaded activity and opening dates without counting it as earnings', async () => {
  const html = await render({ report: operations, businessSummary: summary({ period: 'custom', totalCount: 0, byCurrency: [], byModule: [] }),
    showActivity: true, activityLoaded: true, canExport: true });
  assert.match(html, /<details class="generalCustomDates" open>/);
  assert.match(html, /<details class="card generalReportDetails" id="generalReportActivity" open>/);
  assert.match(html, /No recorded transactions or posted earnings for these dates/);
  assert.match(html, /No activity for the selected source and dates/);
  assert.match(html, /name="activity" value="1"/);
  assert.match(html, /Export activity CSV/);
});

test('staff activity does not render the owner recap or its export', async () => {
  const html = await render({ report: operations, canExport: true });
  assert.match(html, /<details class="card generalReportDetails" id="generalReportActivity" open>/);
  assert.match(html, /name="from"/);
  assert.match(html, /Export activity CSV/);
  assert.doesNotMatch(html, /Business at a glance|Posted profit|Export summary CSV/);
});
