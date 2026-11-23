'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),ejs=require('ejs');
const template=path.join(__dirname,'../src/views/tenant/treasury/detail.ejs');
const owner={id:'507f1f77bcf86cd799439011',role:'Tenant Owner'};
function render(currency,{opened=true,held=false}={}){
 const account={_id:'507f1f77bcf86cd799439012',name:'Real bank balance '+currency,
  code:'BANK_'+currency,kind:'bank',network:'',currency,
  status:held?'held':opened?'active':'uninitialized',
  reconciliationState:held?'mismatch':opened?'matched':'unknown',
  openingBalanceMinor:opened?'0':null,bookBalanceMinor:'0',
  openingApprovedAt:opened?new Date():null,openingObservationId:null,
  pendingOpeningId:null,lastObservedMinor:null,lastVarianceMinor:null,
  lastObservationAt:null,holdReason:''};
 return ejs.renderFile(template,{user:owner,csrfToken:'test-only',assetVersion:'test',
  data:{account,format:(minor,c)=>c+' '+minor,batches:[],movements:[],observations:[],
   adjustments:[],canObserve:true,canManage:true,canReview:false,
   idempotencyKey:'12345678-1234-4123-8123-123456789abc',cashDrawerOptions:[]}});
}
test('Owner uses existing balance panel; no duplicate top-up or balance evidence review',async()=>{
 for(const currency of ['UGX','USD','SSP','KES']){
  const html=await render(currency);
  assert.match(html,/Record actual balance check/);
  assert.match(html,/action="\/tenant\/treasury\/accounts\/507f1f77bcf86cd799439012\/record"/);
  assert.match(html,/<option value="check" selected>/);
  assert.match(html,/name="recordAction"/);
  assert.doesNotMatch(html,/name="action"/,'No named action control may mask the form URL');
  assert.match(html,/value="capital"/);
  assert.match(html,/Current recorded balance/);
  assert(!html.includes('Submit balance evidence for review'));
  assert(!html.includes('name="evidenceReference"'));
  assert(!html.includes('name="confirmed"'));
  assert(!html.includes('id="new-capital"'));
  assert(html.includes(currency==='KES'?'KSH':currency));
 }
});
test('First owner opening uses one amount without a receipt or confirmation checkbox',async()=>{
 const html=await render('USD',{opened:false});
 assert.match(html,/Confirm starting balance/);
 assert.match(html,/name="actualBalance"/);
 assert(!html.includes('name="confirmed"'));
 assert(!html.includes('name="evidenceReference"'));
 assert(!html.includes('Submit balance evidence for review'));
});

test('Held SSP cash still allows audited NEW capital but never clears the balance hold',async()=>{
 const html=await render('SSP',{held:true});
 assert.match(html,/<option value="capital"\s*>Add new business money<\/option>/);
 assert.match(html,/Balance difference still open/);
 assert.match(html,/account remains held/);
 assert.match(html,/Check actual account balance/);
 assert(!html.includes('Submit balance evidence for review'));
});
