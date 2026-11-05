'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const ejs=require('ejs');
const {plans}=require('../src/data/store');
const {publicShape}=require('../src/platform/services/publicPlans.service');
const render=(file,catalogue)=>ejs.renderFile(path.join(__dirname,'../src/views/original',file),{appUrl:'https://classicfin.example',assetVersion:'test',cspNonce:'nonce',plans:catalogue});
const text=html=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
function cardsByCode(html){return Object.fromEntries([...html.matchAll(/<article class="plan-card(?: featured)?" data-plan-code="([^"]+)">([\s\S]*?)<\/article>/g)].map(match=>[match[1],text(match[2])]));}
const custom=changes=>({code:'local_team_manual',name:'Local Team Manual',description:'A configurable local recording service.',currency:'USD',priceMonthly:80,priceYearly:800,trialMonths:1,entryMode:'manual',modules:['mobile_money'],moduleLabels:['Mobile Money'],limits:{users:8,branches:3,transactionsPerMonth:2400,smsPerMonth:0,storageMb:1500},...changes});

test('public pricing keeps named prices and capacity when catalogue order changes',async()=>{
 const html=await render('pricing.ejs',[...plans].reverse().map(plan=>publicShape(plan)));
 const cards=cardsByCode(html);
 assert.equal(Object.keys(cards).length,plans.length);
 assert.match(cards.agent,/Agent Plan USD \$149\.00\/mo/);assert.match(cards.agent,/3 branches and 12 users included/);
 assert.match(cards.finance,/Finance Plan USD \$249\.00\/mo/);assert.match(cards.enterprise,/40 branches and 100 users included/);
 assert.match(cards.modular,/Modular Workspace USD \$0\.00\/mo/);
});
test('arbitrary administrator-created manual and SMS plans render without fixed catalogue codes',async()=>{
 const auto=custom({code:'local_team_auto',name:'Local Team Auto',entryMode:'sms_assisted',priceMonthly:100,priceYearly:1000,modules:['mobile_money','sms_capture'],moduleLabels:['Mobile Money','SMS Capture'],limits:{...custom().limits,smsPerMonth:2400}});
 const cards=cardsByCode(await render('pricing.ejs',[auto,custom()]));
 assert.deepEqual(Object.keys(cards),['local_team_auto','local_team_manual']);
 assert.match(cards.local_team_auto,/SMS-assisted \+ manual entry/);assert.match(cards.local_team_auto,/2,400 SMS imports \/ month; manual entry included/);assert.match(cards.local_team_auto,/USD \$1000\.00 \/ year/);
 assert.match(cards.local_team_manual,/Manual entry/);assert.doesNotMatch(cards.local_team_manual,/SMS imports/);
 const comparison=await render('price-compare.ejs',[custom(),auto]);
 const headings=[...comparison.matchAll(/<th scope="col"(?: data-plan-code="[^"]+")?>([\s\S]*?)<\/th>/g)].map(match=>text(match[1]));
 assert.deepEqual(headings,['Feature','Local Team Manual USD $80.00 / month','Local Team Auto USD $100.00 / month']);
 const row=name=>[...comparison.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(match=>match[1]).find(value=>text(value).startsWith(name));
 assert.match(text(row('Branches included')),/3 3$/);assert.match(text(row('Monthly SMS imports')),/Not included 2,400$/);
 assert.doesNotMatch(comparison,/Agent Plan|Enterprise Plan/);
});
test('no published prices produces a clear empty state instead of stale default prices',async()=>{
 for(const file of ['pricing.ejs','price-compare.ejs']){
  const html=await render(file,[]);assert.match(html,/plans.*(?:prepared|published)/i);assert.doesNotMatch(html,/USD \$149|USD \$249|data-plan-code=/);
 }
});
test('public plan conversion uses persisted exact prices and excludes disabled modules',()=>{
 const result=publicShape({code:'custom',name:'Custom',description:'Custom plan description.',currency:'USD',priceMonthlyMinor:4995,priceYearlyMinor:49950,trialMonths:0,modules:['mobile_money','customer_portal'],limits:custom().limits,entryMode:'manual',version:3},true);
 assert.equal(result.priceMonthly,49.95);assert.equal(result.priceYearly,499.5);assert.equal(result.version,3);assert.deepEqual(result.moduleLabels,['Mobile Money']);
});
