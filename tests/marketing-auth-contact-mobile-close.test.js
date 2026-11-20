'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const source=rel=>fs.readFileSync(path.join(root,rel),'utf8');

test('each public original page uses approved Classic Technologies contacts',()=>{
 const folder=path.join(root,'src/views/original');
 const files=fs.readdirSync(folder).filter(name=>name.endsWith('.ejs'));
 assert(files.length>=15);
 for(const name of files){
  const html=fs.readFileSync(path.join(folder,name),'utf8');
  assert(!/info@classicfinhub\.com|211921789914|\+211 921 789 914|support@classicfinhub\.com|256700000000/.test(html),name+' contains an obsolete public contact');
  assert(html.includes('mailto:info@classictechgroup.com'),name+' must link official business email');
  assert(html.includes('tel:+256773364680'),name+' must link approved call number');
  assert(html.includes('https://wa.me/256781977217'),name+' must link approved WhatsApp');
 }
 const extra=source('src/views/public/contact.ejs');
 assert(extra.includes('info@classictechgroup.com'));
 assert(extra.includes('tel:+256773364680'));
 assert(extra.includes('https://wa.me/256781977217'));
});
test('tenant-owned and payment contact fields are not mass-rewritten',()=>{
 const tenant=source('src/tenant/workspace/service.js');
 assert.match(tenant,/profile\.supportPhone|supportPhone:/);
 const transfers=source('src/views/tenant/money-transfer/contacts.ejs');
 assert(transfers.includes('256700000000'),
  'Customer/example transaction contact is deliberately not the corporate support number');
});
test('both workspace dashboards have a real right-end mobile close control',()=>{
 const sidebar=source('src/views/partials/dashboard-sidebar.ejs');
 const js=source('public/js/dashboard.js');
 const css=source('public/css/dashboard-layout.css');
 assert.match(sidebar,/id="sidePanelClose"[^>]*aria-label="Close navigation menu"/);
 assert.match(js,/sideCloseBtn\?\.addEventListener\('click', \(\) => setMenu\(false, true\)\)/);
 assert.match(css,/#sidePanel \.sidePanelClose\{display:inline-flex!important;position:absolute;right:12px/);
 assert.match(js,/event\.key === 'Escape'/);
});
test('public menus have an accessible close button and restore the trigger focus',()=>{
 const js=source('public/js/script.js');
 const css=source('public/css/style.css');
 assert.match(js,/mobileCloseBtn\.setAttribute\('aria-label', 'Close navigation menu'\)/);
 assert.match(js,/mobileCloseBtn\?\.addEventListener\('click'/);
 assert.match(js,/menuBtn\?\.focus\(\)/);
 assert.match(css,/\.mobile-panel \.mobilePanelClose/);
});
test('password visibility keeps only the eye icon without disabling access',()=>{
 const css=source('public/css/style.css');
 const js=source('public/js/script.js');
 const signin=source('src/views/original/signin.ejs');
 const reset=source('src/views/original/reset-password.ejs');
 assert.match(css,/\.auth-body \.authPasswordField>\.authPasswordToggle/);
 assert.match(css,/background:transparent!important;border:0!important;box-shadow:none!important/);
 assert.match(css,/\.authPasswordToggle:focus-visible/);
 assert.match(signin,/data-password-toggle aria-controls="signinPassword"/);
 assert.match(reset,/data-password-toggle aria-controls="resetNewPassword"/);
 assert.match(js,/icon\.classList\.toggle\('fa-eye-slash',visible\)/);
});
test('Loan Management is a clearly planned future module, never billed or presented live',()=>{
 const home=source('src/views/original/home.ejs');
 const services=source('src/views/original/services.ejs');
 const marketplace=source('src/views/public/marketplace.ejs');
 const guide=source('src/views/public/product-guide.ejs');
 for(const body of [home,services,marketplace,guide]){
  assert.match(body,/Loan Management/);
  assert.match(body,/Coming soon/i);
 }
 const store=require('../src/data/store');
 assert(!store.modules.some(m=>/loan/.test(String(m.key||''))),'Loan Management cannot be enabled before build');
 assert(!source('src/views/public/pricing.ejs').includes('Loan Management'));
});
test('No cross-currency cash-first Deposit or settlement implementation was changed',()=>{
 const entry=source('src/views/tenant/mobile-money/_entry-form.ejs');
 assert.match(entry,/Customer cash received/);
 assert.match(entry,/cashAmountMinor|fxCashAmountMinor/);
 const core=source('src/tenant/services/momoFxSettlement.service.js');
 assert.match(core,/deposit_cash_send_provider/);
 assert.match(core,/idempotencyKey/);
});
