'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { plans } = require('../src/data/store');

const render = (file, catalogue) => ejs.renderFile(path.join(__dirname, '../src/views/original', file), {
  appUrl: 'https://classicfin.example', assetVersion: 'test', cspNonce: 'nonce', plans: catalogue
});
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

test('public pricing keeps prices and capacity with their plan when the catalogue order changes', async () => {
  const html = await render('pricing.ejs', [...plans].reverse());
  const cards = [...html.matchAll(/<article class="plan-card(?: featured)?">([\s\S]*?)<\/article>/g)]
    .map(match => text(match[1]));
  assert.equal(cards.length, 4);
  assert.match(cards[0], /Starter Trial USD \$0/);
  assert.match(cards[0], /150 record limit/);
  assert.match(cards[1], /Agent Plan USD \$149\/mo/);
  assert.match(cards[1], /3 branches and 12 users included/);
  assert.match(cards[2], /Finance Plan USD \$249\/mo/);
  assert.match(cards[2], /6 branches and 25 users included/);
  assert.match(cards[3], /Enterprise Plan USD \$499\/mo/);
  assert.match(cards[3], /40 branches and 100 users included/);
});

test('public comparison uses the same named plan prices and limits as pricing', async () => {
  const catalogue = plans.map((plan, index) => ({
    ...plan,
    priceMonthly: 100 + index,
    limits: { ...plan.limits, branches: 10 + index, users: 20 + index, transactionsPerMonth: 1000 + index }
  })).reverse();
  const html = await render('price-compare.ejs', catalogue);
  const headings = [...html.matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)].map(match => text(match[1]));
  assert.deepEqual(headings, ['Feature', 'Starter Trial USD $101 / trial', 'Agent Plan USD $102 / month',
    'Finance Plan USD $103 / month', 'Enterprise USD $104 / month']);
  const rowCells = name => {
    const row = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map(match => match[1]).find(row => text(row).startsWith(name));
    assert(row, `Missing comparison row: ${name}`);
    return [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(match => text(match[1]));
  };
  assert.deepEqual(rowCells('Branches included'), ['11', '12', '13', '14']);
  assert.deepEqual(rowCells('Users included'), ['21', '22', '23', '24']);
  assert.deepEqual(rowCells('Monthly record limit'), ['1,001', '1,002', '1,003', '1,004']);
});
