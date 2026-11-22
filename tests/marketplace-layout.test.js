'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');

test('marketplace uses dedicated responsive styles and readable introduction',()=>{
  const view=read('src/views/public/marketplace.ejs');
  const css=read('public/css/marketplace.css');
  const layout=read('src/views/layouts/public.ejs');
  assert.match(view,/marketplace-grid/);
  assert.match(view,/marketplace-description/);
  assert.match(css,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css,/@media\(max-width:680px\)/);
  assert.match(layout,/currentPath==='\/marketplace'/);
  assert.match(layout,/\/css\/marketplace\.css/);
  assert.doesNotMatch(view,/class="price-card/);
  assert.doesNotMatch(view,/class="pricing-grid/);
});

test('marketplace identifies manual modules and does not claim automatic billing or telecom fulfillment',()=>{
  const view=read('src/views/public/marketplace.ejs');
  assert.match(view,/runtimeStatus !== 'disabled'/);
  assert.match(view,/Recording workflow/);
  assert.match(view,/Module availability and actual fees are confirmed during setup/);
  assert.doesNotMatch(view,/module\.priceMonthly/);
  assert.match(view,/href="\/#book"/);
});
