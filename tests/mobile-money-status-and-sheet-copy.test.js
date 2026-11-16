'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const src=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
test('historical booked Mobile Money transactions no longer look like unposted approval requests',()=>{
 const detail=src('src/views/tenant/mobile-money/detail.ejs');
 const index=src('src/views/tenant/mobile-money/index.ejs');
 const activity=src('src/views/tenant/mobile-money/_activity.ejs');
 for(const view of [detail,index,activity]){
  assert.match(view,/fundingState==='book_recorded'/);
  assert.match(view,/Recorded in books|Recorded in cash and float books/);
  assert.doesNotMatch(view,/status\.replaceAll\('_',' '\)/);
 }
 assert.match(detail,/Network settlement:/);
 assert.match(detail,/Not independently verified in FinHub/);
 assert.match(detail,/\['accepted','disputed'\]\.includes\(data\.record\.reviewState\)/);
 assert.doesNotMatch(detail,/Record status:<\/b>/);
});
test('one provider rate sheet exposes only amount-band copy, not cloned commissions or approval',()=>{
 const view=src('src/views/tenant/mobile-money/tariffs.ejs');
 const js=src('public/js/network-tariffs.js');
 assert.match(view,/data-copy-rate-template/);
 assert.match(view,/op\.rows\.map\(row=>\(\{minMinor:row\.minMinor,maxMinor:row\.maxMinor\}\)\)/);
 assert.match(view,/data-copy-rate-status/);
 assert.match(js,/targetCurrency===template\.sourceCurrency/);
 assert.match(js,/sourceNetwork:button\.dataset\.copySourceNetwork/);
 assert.match(js,/const sameMarket=target===template\.sourceNetwork/);
 assert.match(js,/if\(!min\|\|!max\|\|amount===null\)/);
 assert.match(js,/\[String\(range\.minMinor\),String\(range\.maxMinor\),'flat',''\]/);
 assert.match(js,/textarea\.value=''; \/\/ requires user to enter provider-specific rates explicitly/);
 assert.match(js,/const evidence=draftForm\.elements\.namedItem\('evidenceReference'\);if\(evidence\)evidence\.value='';/);
 assert.doesNotThrow(()=>new Function(js));
});
test('cash shifts label counted existing cash and do not require separate approvals for completed transaction records',()=>{
 const shifts=src('src/views/tenant/mobile-money/shifts.ejs');
 const detail=src('src/views/tenant/mobile-money/shift-detail.ejs');
 const close=src('src/views/tenant/workflow/close-day.ejs');
 assert.match(shifts,/opening a shift never creates or adds money/i);
 assert.match(shifts,/Counted cash already in your drawer/);
 assert.match(detail,/Recorded transactions already affect the internal cash book/);
 assert.match(close,/Transactions themselves are recorded immediately/);
});
