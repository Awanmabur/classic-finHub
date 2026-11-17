'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const fs=require('node:fs');
const path=require('node:path');
for(const file of ['fx.ejs','fx-history.ejs','fx-authorizations.ejs']){
 test('cross-currency '+file+' EJS template compiles',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/views/tenant/mobile-money',file),'utf8');
  assert.doesNotThrow(()=>ejs.compile(source,{filename:file}));
 });
}

test('authorized owner can see real wallet/cash pair onboarding; unauthorized reviewer cannot submit grants',async()=>{
 const view=path.join(__dirname,'../src/views/tenant/mobile-money/fx-authorizations.ejs');
 const base={branchId:'507f1f77bcf86cd799439011',items:[],
  wallets:[{id:'507f1f77bcf86cd799439012',name:'MTN Float',network:'MTN',currency:'UGX'}],
  drawers:[{id:'507f1f77bcf86cd799439013',name:'SSP cash',currency:'SSP'}]};
 const owner=await ejs.renderFile(view,{data:{...base,canRequest:true,canReview:false},user:{id:'owner'},csrfToken:'csrf',formatLocalDate:()=>''});
 assert.match(owner,/name="providerAuthorizationReference"/);
 assert.match(owner,/name="regulatoryAuthorizationReference"/);
 assert.match(owner,/name="confirmedDocuments"/);
 assert.match(owner,/MTN Float/);
 const reviewer=await ejs.renderFile(view,{data:{...base,canRequest:false,canReview:true},user:{id:'reviewer'},csrfToken:'csrf',formatLocalDate:()=>''});
 assert.doesNotMatch(reviewer,/name="providerAuthorizationReference"/);
});
test('banking and remittance modules expose two-way Forex trades only under assigned permission',()=>{
 const banking=fs.readFileSync(path.join(__dirname,'../src/views/tenant/banking/index.ejs'),'utf8');
 const transfer=fs.readFileSync(path.join(__dirname,'../src/views/tenant/money-transfer/index.ejs'),'utf8');
 for(const [source,module] of [[banking,'banking'],[transfer,'money_transfer']]){
  assert.match(source,/if\(data\.canFx\)/);
  assert(source.includes('/tenant/forex/buy?originModule='+module));
  assert(source.includes('/tenant/forex/sell?originModule='+module));
 }
});
