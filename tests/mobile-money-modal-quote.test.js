'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=part=>fs.readFileSync(path.join(__dirname,'..',part),'utf8');

test('newly mounted Mobile Money popup receives MTN rates without refreshing or entering a fee sheet',async()=>{
 const quoteSource=source('public/js/mobile-money-quote.js');
 const events=new Map(),requests=[];
 const field=value=>({
  value, handlers:new Map(),
  addEventListener(name,fn){if(!this.handlers.has(name))this.handlers.set(name,[]);this.handlers.get(name).push(fn);},
  fire(name){for(const fn of this.handlers.get(name)||[])fn();}
 });
 const fields={network:field('MTN'),currency:field('UGX'),amount:field('500000')};
 const elements={
  commission:{textContent:'Enter an amount to check'},
  customerFee:{textContent:'Enter an amount to check'},
  note:{textContent:''}
 };
 const summary={
  querySelector(selector){
   return {'[data-mobile-agent-commission]':elements.commission,
    '[data-mobile-provider-charge]':elements.customerFee,
    '[data-mobile-quote-note]':elements.note}[selector]||null;
  }
 };
 const form={
  dataset:{operation:'cash_in'},
  matches:selector=>selector==='[data-mobile-money-form]',
  querySelector:selector=>selector==='[data-mobile-provider-quote]'?summary:null,
  elements:{namedItem:name=>fields[name]||null}
 };
 const win={},document={querySelectorAll:()=>[]};
 const fetch=async url=>{
  const u=new URL(url),operation=u.searchParams.get('operation');
  requests.push(u);
  assert.equal(u.searchParams.get('network'),'MTN');
  assert.equal(u.searchParams.get('currency'),'UGX');
  const isDeposit=operation==='cash_in';
  return {ok:true,json:async()=>({
   agentCommission:{amount:isDeposit?'UGX 950':'UGX 600',source:'published_reference'},
   customerNetworkCharge:{amount:isDeposit?'UGX 0':'UGX 1,925',source:'published_reference'},
   note:'Published rate reference, not booked revenue'
  })};
 };
 new Function('document','window','location','fetch','setTimeout','clearTimeout','MutationObserver',quoteSource)(
  document,win,{origin:'https://classicfinhub.com'},fetch,
  callback=>{Promise.resolve().then(callback);return 1;},()=>{},class{observe(){}}
 );
 assert.equal(typeof win.ClassicFinMobileQuote.initialise,'function');
 win.ClassicFinMobileQuote.initialise(form);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests.length,1);
 assert.equal(requests[0].searchParams.get('amount'),'500000');
 assert.equal(elements.commission.textContent,'UGX 950 · published reference only');
 assert.equal(elements.customerFee.textContent,'UGX 0 · published reference only');
 win.ClassicFinMobileQuote.initialise(form);
 assert.equal(fields.amount.handlers.get('input').length,1,'form must only be bound once');
 form.dataset.operation='cash_out';fields.amount.value='100000';
 fields.amount.fire('input');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests.at(-1).searchParams.get('operation'),'cash_out');
 assert.equal(elements.customerFee.textContent,'UGX 1,925 · published reference only');
 assert.equal(elements.commission.textContent,'UGX 600 · published reference only');
});
test('the transaction launcher invokes the shared rate calculator on every newly inserted form',()=>{
 const dashboard=source('public/js/dashboard.js');
 const inserted=dashboard.slice(dashboard.indexOf('formHost.replaceChildren(form)'),dashboard.indexOf("message('');",dashboard.indexOf('formHost.replaceChildren(form)')));
 assert.match(inserted,/window\.ClassicFinMobileQuote\?\.initialise\(form\)/);
 assert.match(dashboard,/window\.ClassicFinMobileQuote\?\.initialise\(seed\)/);
 assert.match(dashboard,/window\.ClassicFinMobileQuote\?\.initialise\(present\)/);
 const layout=source('src/views/layouts/dashboard.ejs');
 assert.match(layout,/\/js\/mobile-money-quote\.js\?v=<%= assetVersion %>/);
});
