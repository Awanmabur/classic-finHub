'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const createApp = require('../src/app');
const ejs = require('ejs');

function element() {
  const names = new Set(), events = {}, attributes = {};
  return {
    classList: {
      add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name),
      toggle(name, enabled = !names.has(name)) { if(enabled) names.add(name); else names.delete(name); return enabled; }
    },
    style: {}, attributes, events, children: [],
    addEventListener(name, handler) { events[name] = handler; },
    setAttribute(name, value) { attributes[name] = value; },
    querySelectorAll() { return this.children; },
    querySelector() { return null; },
    appendChild() {}, focus() { this.focused = true; }
  };
}

test('tenant form explains invalid fields and shows progress during creation', () => {
  const form = element(), status = element(), submit = element();
  submit.textContent = 'Create tenant and private invitation';
  status.hidden = true;
  form.querySelector = selector => selector === '[data-tenant-form-status]' ? status : submit;
  const events = {};
  const document = {
    body: element(), getElementById: () => null, addEventListener() {}, querySelector: () => null,
    querySelectorAll: selector => selector === '[data-tenant-create-form]' ? [form] : []
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/dashboard.js'), 'utf8'), {
    document, window: {matchMedia: () => ({matches:false,addEventListener(){}}),addEventListener(name, handler) {events[name] = handler;}}
  });
  form.events.invalid({target:{validationMessage:'Please select an item in the list.'}});
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /Please select an item/);
  form.events.submit();
  assert.equal(submit.disabled, true, 'a second click must not issue a duplicate creation request');
  assert.match(status.textContent, /preparing the owner invitation/);
  assert.equal(submit.textContent, 'Creating tenant…');
  events.pageshow();
  assert.equal(submit.disabled, false, 'back navigation must restore a usable form');
  assert.equal(submit.textContent, 'Create tenant and private invitation');
  assert.equal(status.hidden, true);
});

test('mobile dashboard navigation supports Escape, focus trapping and desktop resize', () => {
  const side = element(), overlay = element(), button = element(), first = element(), last = element();
  side.children = [first, last];
  const ids = {sidePanel: side, menuOverlay: overlay, menuBtn: button};
  const document = {body: element(), getElementById: id => ids[id], querySelectorAll: () => [], querySelector: () => null, events: {}, addEventListener(name, handler) { this.events[name] = handler; }};
  const media = {matches: true, addEventListener(name, handler) { this.change = handler; }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/dashboard.js'), 'utf8'), {document, window: {matchMedia: () => media}});
  assert.equal(side.inert, true, 'closed offscreen navigation must not remain keyboard focusable');
  button.events.click();
  assert.equal(side.inert, false);
  assert.equal(first.focused, true);
  assert.equal(button.attributes['aria-expanded'], 'true');
  document.activeElement = last;
  let prevented = false;
  first.focused = false;
  document.events.keydown({key: 'Tab', preventDefault() { prevented = true; }});
  assert(prevented);
  assert(first.focused);
  document.events.keydown({key: 'Escape', preventDefault() {}});
  assert.equal(button.attributes['aria-expanded'], 'false');
  assert(button.focused);
  assert.equal(side.inert, true);
  media.matches = false;
  media.change();
  assert.equal(side.inert, false, 'desktop sidebar must remain available');
});

test('public navigation and reveal content survive blocked storage and missing observer support', () => {
  const button = element(), panel = element(), reveal = element(), year = element();
  const ids = {menuBtn: button, mobilePanel: panel, year};
  const events = {};
  const document = {
    body: element(), documentElement: {scrollHeight: 900},
    getElementById: id => ids[id], querySelector: () => null,
    querySelectorAll: selector => selector === '.reveal' ? [reveal] : [],
    createElement: element, addEventListener(name, handler) { events[name] = handler; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/script.js'), 'utf8'), {
    document,
    window: {innerHeight: 600, scrollY: 0, location: {pathname: '/'}, addEventListener() {}},
    localStorage: {getItem() { throw new Error('Storage disabled'); }, setItem() { throw new Error('Storage disabled'); }}
  });
  assert(reveal.classList.contains('show'), 'content must remain visible without IntersectionObserver');
  button.events.click();
  assert(panel.classList.contains('open'));
  assert.equal(button.attributes['aria-expanded'], 'true');
  events.keydown({key: 'Escape'});
  assert(!panel.classList.contains('open'));
  assert(button.focused);
});

test('dashboard CSS image URLs resolve through the running application', async () => {
  const server = createApp().listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const cssUrl = base + '/css/dashboard.css';
    const css = await (await fetch(cssUrl)).text();
    const urls = [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)].map(match => match[1] || match[2] || match[3]).filter(url => !url.startsWith('data:'));
    assert(urls.length > 0);
    for (const url of new Set(urls)) {
      const response = await fetch(new URL(url, cssUrl));
      assert.equal(response.status, 200, `Missing dashboard asset: ${url}`);
      assert.match(response.headers.get('content-type'), /^image\//);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

function overview(role, permissions, paths, data) {
  return ejs.renderFile(path.join(__dirname, '../src/views/layouts/dashboard.ejs'), {
    context: 'tenant', pageTitle: 'Overview', pageSub: 'Authorized activity', currentPath: '/tenant/dashboard',
    tenant: {slug: 'test-workspace', name: 'Testing', status: 'active', plan: 'modular'},
    user: {name: 'Staff', role, permissions}, menu: [{label: 'Workspace', items: paths.map(href => ({href, label: href, icon: 'fa-gauge-high'}))}],
    view: '../tenant/dashboard/index', data, flash: null, csrfToken: 'test', assetVersion: 'test', money: String, amountFromMinor: String
  });
}

test('overview restores approved snapshot cards and quick actions using real authorized module data', async () => {
  const html = await overview('Tenant Owner', ['*'], ['/tenant/money-transfer', '/tenant/mobile-money', '/tenant/banking', '/tenant/forex', '/tenant/reports'], {
    hasTransfer: true, transferRecords: {items: []}, hasMobileMoney: true, summary: {total: 23, awaitingReview: 2, recent: [], summaries: []},
    hasBanking: true, bankingRecords: {items: []}, hasForex: true, forexRecords: {items: []}
  });
  assert.match(html, /Today snapshot/);
  for (const label of ['Money Transfer requests', 'Mobile Money records', 'Banking requests', 'Forex quotes', 'New money transfer', 'New mobile money', 'New banking', 'New forex', 'View reports']) assert(html.includes(label), label);
  assert.match(html, /class="v">23<\/div>/);
  assert.doesNotMatch(html, /Load demo|id="branchSelect"|Cash drawer by currency/);
  assert.match(html,/href="\/tenant\/money-transfer\/send" data-transaction-kind="transfer"/);
  assert.match(html,/href="\/tenant\/banking\/deposit" data-transaction-kind="banking_deposit"/);
});

test('read-only overview never offers write actions or links to unassigned modules', async () => {
  const html = await overview('Viewer', ['dashboard.view', 'mobile_money.view'], ['/tenant/dashboard', '/tenant/mobile-money'], {
    hasMobileMoney: true, summary: {total: 0, awaitingReview: 0, recent: [], summaries: []}
  });
  assert.match(html, /href="\/tenant\/mobile-money\/history"/);
  assert.doesNotMatch(html, /New mobile money|New money transfer|New banking|New forex|href="\/tenant\/reports"/);
});
