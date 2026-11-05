'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');
const approved=require('../src/tenant/services/approvedDashboard.service');

test('authenticated dashboard uses exactly the original index.html sections and wording',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const expected=source.slice(source.indexOf('<div class="grain"'),source.indexOf('</main>')+7);
  assert(approved.originalMain===expected);
  const html=approved.markup({name:'Role Name',role:'Tenant Owner'});
  for(const wording of ['Today snapshot','Send money / Generate PIN','Payout by PIN','Cash-in','Cash-out',
    'Buy forex from customer','Sell forex to customer','Accounts directory','Customers directory','Operation reports',
    'New transaction','Last receipt','Forex cash impact','New account'])assert(html.includes(wording),wording);
  assert(html.includes('id="view-forex-rates"'));
  assert(html.includes('id="view-report-forex"'));
  assert(html.includes('id="view-banking"'));
  assert.doesNotMatch(html,/<script[\s>]/);
  assert(!html.includes('AGT-0193'));
  assert(html.includes('Role Name'));
  assert(!html.includes('id="openBadge">OPEN'));
});

test('approved dashboard escapes user-controlled HTML and CSS image path works',()=>{
  const html=approved.markup({name:'<img src=x onerror=alert(1)>',role:'Operator'});
  assert(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert(!html.includes('id="sideOperator"><img'));
  assert.match(approved.originalCss,/url\("\/images\/classicfinhub-logo\.png"\)/);
  assert(!approved.originalCss.includes('url("images/classicfinhub-logo.png")'));
  assert.equal(approved.safeJson({x:'</script><svg onload=alert(1)>',v:'&'}).includes('</script>'),false);
});

test('approved dashboard EJS reproduces reference shell while using safe external JS',async()=>{
  const html=await ejs.renderFile(path.join(__dirname,'../src/views/layouts/approved-dashboard.ejs'),{
    approvedCss:approved.originalCss,
    approvedMarkup:approved.markup({name:'Viewer',role:'Tenant Owner'}),
    approvedConfig:approved.safeJson({access:{},recent:{},branches:[]}),
    assetVersion:'test'
  });
  assert.match(html,/id="view-overview"/);
  assert(html.includes('Sending / Generate PIN'));
  assert(html.includes('Payout by PIN'));
  assert(html.includes('Close day'));
  assert.doesNotMatch(html,/id="view-money"/); // no fabricated section
  assert.match(html,/id="approvedOperationOverlay"/);
  assert.match(html,/src="\/js\/approved-dashboard\.js\?v=test"/);
  assert.doesNotMatch(html,/<script>(?!\s*<\/script>)/);
});

test('client dashboard uses original approved navigation and secure document POST forms',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/js/approved-dashboard.js'),'utf8');
  assert.match(source,/new DOMParser\(\)/);
  assert.match(source,/input\[name="_csrf"\]/);
  assert.match(source,/f\.getAttribute\('method'\).*toLowerCase\(\)==='post'/);
  assert.match(source,/data-view/);
  assert.match(source,/data-open/);
  assert.match(source,/data-quick/);
  assert(!source.includes('localStorage'));
  assert(!source.includes('Math.random'));
  assert(!source.includes('Generate PIN')||source.includes('no PIN is generated'));
  assert(!source.includes('db.txns.unshift'));
});

test('reference demo/reset controls and service chooser cannot create fake financial records',()=>{
 const script=fs.readFileSync(path.join(__dirname,'../public/js/approved-dashboard.js'),'utf8');
 assert(script.includes("node.id==='demoBtn'"));
 assert(script.includes("node.id==='resetBtn'"));
 assert(script.includes("data-approved-service"));
 assert(script.includes('form.addEventListener'));
 assert(script.includes('if(submitted){event.preventDefault();return;}'));
 assert(!script.includes('db.txns.unshift'));
});
