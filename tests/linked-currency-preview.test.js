'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {entitledTenant}=require('./helpers/entitlement');
const preview=require('../src/tenant/settlements/preview');
const {tenantDbNameFromSlug}=require('../src/config/tenantDatabaseName');
const ids={tenant:'507f1f77bcf86cd799439010',branch:'507f1f77bcf86cd799439011',
 dest:'507f1f77bcf86cd799439012',actor:'507f1f77bcf86cd799439013',
 wallet:'507f1f77bcf86cd799439014',cash:'507f1f77bcf86cd799439015',
 payout:'507f1f77bcf86cd799439016',rate:'507f1f77bcf86cd799439017',
 maker:'507f1f77bcf86cd799439018',reviewer:'507f1f77bcf86cd799439019'};
const tenant=entitledTenant({plan:'enterprise',_id:ids.tenant,slug:'test-finance',dbName:tenantDbNameFromSlug('test-finance')});
const actor={id:ids.actor,role:'Tenant Owner',permissions:['*'],allowedModules:[],branchId:ids.branch,transactionBranchId:ids.branch};
const currencies=['SSP','USD','UGX','KES'];
const branch={_id:ids.branch,currency:'SSP',currencies,status:'active'};
const dest={_id:ids.dest,currency:'USD',currencies,status:'active'};
function account(_id,branchId,currency,kind,extra={}){
 return {_id,tenantId:tenant._id,branchId,kind,currency,moduleKey:kind==='cash'?'shared':'mobile_money',
  network:kind==='wallet'?'MTN':'',operatorId:ids.actor,
  openingBalanceMinor:'1000000000',openingApprovedAt:new Date('2026-01-01'),
  status:'active',reconciliationState:'matched',...extra};
}
function environment({wallet=account(ids.wallet,ids.branch,'UGX','wallet'),
 drawer=account(ids.cash,ids.branch,'SSP','cash'),
 payout=account(ids.payout,ids.dest,'USD','cash',{operatorId:ids.reviewer}),
 quotedSide='buy',rateFrom='UGX',rateTo='SSP'}={}){
 const queries=[];
 const rate={_id:ids.rate,branchId:ids.branch,fromCurrency:rateFrom,toCurrency:rateTo,
  side:quotedSide,rateDecimal:'0.9',status:'active',proposedBy:ids.maker,
  reviewedBy:ids.reviewer,reviewedAt:new Date('2026-11-16'),
  expiresAt:new Date('2030-01-01')};
 const accountModel={
  find(query){queries.push({kind:'find',query});return{limit(){return this;},session(){return this;},lean:async()=>{
   return [drawer].filter(a=>String(a.tenantId)===String(query.tenantId)&&String(a.branchId)===String(query.branchId)&&
    a.kind===query.kind&&a.currency===query.currency&&String(a.operatorId)===String(query.operatorId));
  }};},
  findOne(query){queries.push({kind:'findOne',query});return{session(){return this;},lean:async()=>{
   const found=[wallet,payout].find(a=>String(a._id)===String(query._id)&&
    String(a.tenantId)===String(query.tenantId)&&String(a.branchId)===String(query.branchId)&&
    a.kind===query.kind&&a.currency===(query.currency||a.currency));
   return found||null;
  }};}
 };
 const readModel=(value)=>({findOne(query){return{session(){return this;},lean:async()=>value&&
  (query._id===undefined||String(value._id)===String(query._id))?value:null};}});
 const conn={name:tenant.dbName,models:{
  TreasuryAccountV1:accountModel,
  SecureBranch:{findOne(query){return{session(){return this;},lean:async()=>[branch,dest].find(b=>String(b._id)===String(query._id))||null};}},
  ForexRateV1:readModel(rate)
 },model(name){return this.models[name]||(this.models[name]={});}};
 return {conn,queries};
}
test('UGX wallet withdrawal quotes SSP from exactly the existing physical cashier drawer',async()=>{
 const e=environment();
 const result=await preview.mobileMoney(e.conn,tenant,actor,branch,{
  operation:'cash_out',walletAccountId:ids.wallet,cashCurrency:'SSP',
  providerPrincipalMinor:'100000',rateId:ids.rate});
 assert.equal(result.quote.custodyLegs[0].currency,'UGX');
 assert.equal(result.quote.custodyLegs[0].deltaMinor,'100000');
 assert.equal(result.quote.custodyLegs[1].currency,'SSP');
 assert.equal(result.quote.custodyLegs[1].deltaMinor,'-9000000');
 assert.equal(result.display.postingStatus,'quote_only');
 assert.equal(result.display.providerConfirmation,'not_yet_verified');
 const drawQuery=e.queries.find(x=>x.kind==='find').query;
 assert.equal(drawQuery.moduleKey,'shared');
 assert.equal(String(drawQuery.operatorId),ids.actor);
 assert.equal(drawQuery.currency,'SSP');
});
test('cross-currency quote cannot borrow another cashier drawer or silently default to native wallet currency',async()=>{
 const wrong=environment({drawer:account(ids.cash,ids.branch,'SSP','cash',{operatorId:ids.reviewer})});
 await assert.rejects(preview.mobileMoney(wrong.conn,tenant,actor,branch,{
  operation:'cash_out',walletAccountId:ids.wallet,cashCurrency:'SSP',
  providerPrincipalMinor:'100000',rateId:ids.rate}),{status:409});
 const same=environment();
 await assert.rejects(preview.mobileMoney(same.conn,tenant,actor,branch,{
  operation:'cash_out',walletAccountId:ids.wallet,cashCurrency:'UGX',
  providerPrincipalMinor:'100000',rateId:ids.rate}),{status:409});
});
test('owner cannot swap authenticated tenant DB or branch by submitting a different account',async()=>{
 const e=environment();
 await assert.rejects(preview.mobileMoney({...e.conn,name:'other_tenant'},tenant,actor,branch,{
  operation:'cash_out',walletAccountId:ids.wallet,cashCurrency:'SSP',
  providerPrincipalMinor:'100000',rateId:ids.rate}),{status:403});
 await assert.rejects(preview.mobileMoney(e.conn,tenant,actor,dest,{
  operation:'cash_out',walletAccountId:ids.wallet,cashCurrency:'SSP',
  providerPrincipalMinor:'100000',rateId:ids.rate}),{status:403});
});
test('transfer preview uses native SSP collection and real destination USD drawer without booking payment',async()=>{
 const e=environment({quotedSide:'sell',rateFrom:'USD',rateTo:'SSP'});
 const result=await preview.transfer(e.conn,tenant,actor,branch,{
  originCashAccountId:ids.cash,collectionCurrency:'SSP',
  destinationBranchId:ids.dest,destinationPayoutAccountId:ids.payout,
  payoutCurrency:'USD',payoutMinor:'10000',rateId:ids.rate});
 assert.equal(result.quote.collectionStage.currency,'SSP');
 assert.equal(result.quote.payoutStage.currency,'USD');
 assert.equal(result.display.collectionStatus,'not_posted');
 assert.equal(result.display.payoutStatus,'not_posted');
});

test('Mobile Money-only tenant can quote KES/SSP without separately buying Forex, but standalone transfer conversion remains gated',async()=>{
 const owner={...actor,allowedModules:['mobile_money']};
 const momoTenant=entitledTenant({plan:'agent',_id:tenant._id,slug:tenant.slug,
   dbName:tenant.dbName,enabledModules:['mobile_money']});
 const kWallet=account(ids.wallet,ids.branch,'KES','wallet',{network:'M-Pesa'});
 const e=environment({wallet:kWallet,rateFrom:'KES',rateTo:'SSP'});
 const out=await preview.mobileMoney(e.conn,momoTenant,owner,branch,{
  operation:'cash_out',walletAccountId:ids.wallet,cashCurrency:'SSP',
  providerPrincipalMinor:'100000',rateId:ids.rate});
 assert.equal(out.quote.providerCurrency,'KES');
 assert.equal(out.quote.cashCurrency,'SSP');
 assert.equal(out.quote.custodyLegs[1].deltaMinor,'-9000000');
 await assert.rejects(preview.transfer(e.conn,momoTenant,owner,branch,{
  originCashAccountId:ids.cash,collectionCurrency:'SSP',
  destinationBranchId:ids.dest,destinationPayoutAccountId:ids.payout,
  payoutCurrency:'USD',payoutMinor:'10000',rateId:ids.rate}),{status:403});
});
