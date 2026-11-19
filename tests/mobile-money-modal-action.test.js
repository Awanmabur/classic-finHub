'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const source=file=>fs.readFileSync(path.join(root,file),'utf8');

test('transaction modal switches submit button between Record deposit and Record withdrawal',()=>{
 const js=source('public/js/dashboard.js');
 const start=js.indexOf('    const syncMobileOperation=(form,kind)=>{');
 const end=js.indexOf('    const lastKinds = new Map();',start);
 assert(start>=0&&end>start,'shared operation label synchronizer must exist');
 const fn=new Function(js.slice(start,end)+'\nreturn syncMobileOperation;')();
 const button={textContent:'Record deposit'};
 const field={value:'Deposit'};
 const form={
  dataset:{operation:'cash_in'},
  matches:selector=>selector==='[data-mobile-money-form]',
  querySelector:selector=>selector==='[data-mobile-operation-label]'?field:
   selector==='[data-mobile-submit-label]'?button:null,
  querySelectorAll:()=>[button]
 };
 fn(form,'cash_out');
 assert.equal(form.dataset.operation,'cash_out');
 assert.equal(field.value,'Withdrawal');
 assert.equal(button.textContent,'Record withdrawal');
 fn(form,'cash_in');
 assert.equal(form.dataset.operation,'cash_in');
 assert.equal(field.value,'Deposit');
 assert.equal(button.textContent,'Record deposit');
 const other={...form,dataset:{operation:'forex'}};
 fn(other,'forex');
 assert.equal(other.dataset.operation,'forex');
});
test('popup lifecycle synchronizes action wording on reuse, first mount, cached seed and reset',()=>{
 const js=source('public/js/dashboard.js');
 assert.match(js,/present\.action=operations\[kind\]\.action;syncMobileOperation\(present,kind\)/);
 assert.match(js,/formHost\.append\(seed\);syncMobileOperation\(seed,kind\)/);
 assert.match(js,/form\.append\(submitActions\);syncMobileOperation\(form,kind\)/);
 assert.match(js,/if\(form\.matches\('\[data-mobile-money-form\]'\)\)syncMobileOperation\(form,currentKind\)/);
 const entry=source('src/views/tenant/mobile-money/_entry-form.ejs');
 assert.match(entry,/data-mobile-submit-label/);
 const label=source('src/views/tenant/partials/operation-pricing.ejs');
 assert.match(label,/Additional agent service fee/);
 const pricing=source('public/js/operation-pricing.js');
 assert.match(pricing,/No extra agent service fee is configured/);
 assert.match(pricing,/Network charges and provider commission are separate/);
});

test('record action provides cashier acknowledgement in both full page and modal with no checkbox',()=>{
 const entry=source('src/views/tenant/mobile-money/_entry-form.ejs');
 const modal=source('public/js/dashboard.js');
 const unified=source('public/js/mobile-money-unified.js');
 assert.match(entry,/type="submit" data-mobile-submit-label/);
 assert.doesNotMatch(entry,/name="transactionConfirmed"/);
 const routes=source('src/tenant/routes/index.js');
 assert.match(routes,/transactionConfirmed:'yes'/,'Authenticated Record POST must work without a submitter value');
 assert.doesNotMatch(routes,/transactionConfirmed:req\.body\.transactionConfirmed/);
 assert.doesNotMatch(entry,/type="checkbox" name="transactionConfirmed"/);
 assert.doesNotMatch(entry,/name="networkReference"/);
 assert.match(modal,/formHost\.insertBefore\(status,activeForm\)/,
  'Dialog failures belong directly before the active form');
 assert.match(modal,/status\.scrollIntoView/);
 assert.doesNotMatch(unified,/transactionCheck\?\.checked/);
 assert.match(unified,/form\.closest\('\[data-operation-dialog\]'\)/);
 assert.match(unified,/showInline\(outcome\.message/);
});
