'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const ejs=require('ejs');
const rates=require('../src/tenant/settlements/mobileMoneyRates.service');
test('Mobile Money cash conversion rate proposal requires two distinct currencies, explicit buy/sell, exact positive rate and documented evidence',()=>{
 const good={fromCurrency:'KES',toCurrency:'SSP',side:'buy',rateDecimal:'13.50',
  validHours:'24',note:'Actual documented branch cash rate'};
 assert.deepEqual(rates.proposal(good),{fromCurrency:'KES',toCurrency:'SSP',side:'buy',rateDecimal:'13.50',hours:24,note:good.note});
 for(const bad of [
  {fromCurrency:'KES',toCurrency:'KES'},
  {fromCurrency:'BTC'},{side:'quote'},{side:'BUY'},
  {rateDecimal:'-1'},{rateDecimal:'0'},
  {rateDecimal:'13.123456789'},{validHours:'100'},
  {note:'short'},{note:'Invalid\nheader'}
 ]){
  assert.throws(()=>rates.proposal({...good,...bad}),error=>[400,409].includes(error.status));
 }
 assert.equal(rates.MAKERS.has('Mobile Money Operator'),true);
 assert.equal(rates.REVIEWERS.has('Mobile Money Operator'),false);
 assert.equal(rates.REVIEWERS.has('Reconciliation Officer'),true);
});
test('currency approval requires an actual review decision and sufficiently clear recorded evidence',()=>{
 assert.deepEqual(rates.decision({decision:'approve',note:'Independent cash rate source reviewed'}),
  {decision:'approve',note:'Independent cash rate source reviewed'});
 for(const invalid of [{decision:'accepted',note:'Independent cash rate source reviewed'},
  {decision:'approve',note:'ok'},
  {decision:'reject',note:'invalid\nheader evidence'}])
  assert.throws(()=>rates.decision(invalid),{status:400});
});
test('Mobile Money currency board renders actual SSP/KES pair, CSRF and independent approval only for a different user',async()=>{
 const view=path.join(__dirname,'../src/views/tenant/mobile-money/currency-rates.ejs');
 const rate={_id:'507f1f77bcf86cd799439011',
   fromCurrency:'KES',toCurrency:'SSP',side:'buy',rateDecimal:'13.5',
   status:'pending_review',expiresAt:new Date('2030-01-01'),proposedBy:'507f1f77bcf86cd799439012'};
 const data={branch:{name:'South Sudan cash counter'},currencies:['KES','SSP'],
   records:[rate],canPropose:true,canReview:true};
 const csrfToken='a'.repeat(64);
 const reviewer=await ejs.renderFile(view,{data,csrfToken,user:{id:'507f1f77bcf86cd799439013'}});
 assert.match(reviewer,/Mobile Money cash exchange rates/);
 assert.match(reviewer,/KES/);
 assert.match(reviewer,/SSP/);
 assert.match(reviewer,/name="_csrf"/);
 assert.match(reviewer,/name="decision" value="approve"/);
 const maker=await ejs.renderFile(view,{data,csrfToken,user:{id:rate.proposedBy}});
 assert.doesNotMatch(maker,/name="decision" value="approve"/);
 const readOnly=await ejs.renderFile(view,{data:{...data,canPropose:false,canReview:false},
  csrfToken,user:{id:'507f1f77bcf86cd799439014'}});
 assert.doesNotMatch(readOnly,/Propose currency rate/);
 assert.doesNotMatch(readOnly,/name="decision" value="approve"/);
});