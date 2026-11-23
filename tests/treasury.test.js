'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),mongoose=require('mongoose');
const service=require('../src/tenant/treasury/service'),schemas=require('../src/tenant/treasury/models');
const {randomUUID}=require('node:crypto');
test('funds amounts use exact bounded minor units and reject ambiguous currencies and overdraft claims',()=>{
 assert.equal(service.major('123.45','USD'),12345n);assert.equal(service.major('123','UGX'),123n);assert.equal(service.major('0.01','SSP'),1n);
 assert.equal(service.major('-10.25','USD',{negative:true}),-1025n);
 for(const [amount,currency]of[['1.2','UGX'],['1.234','USD'],['-1','USD'],['1e5','USD'],['001','USD'],['1000000000000000000','UGX'],['1','KSH']])assert.throws(()=>service.major(amount,currency));
 assert.throws(()=>service.signedMinor('0',{zero:false}));assert.throws(()=>service.signedMinor('1.2'));assert.throws(()=>service.signedMinor('1000000000000000000'));
});
test('actual fund configuration binds cash to operators and wallets to named networks without balances',()=>{
 const cash={code:'CASH_MAIN',name:'Main drawer',kind:'cash',currency:'UGX',operatorId:String(new mongoose.Types.ObjectId())};
 assert.equal(service.validateAccount(cash).operatorId,cash.operatorId);assert.throws(()=>service.validateAccount({...cash,operatorId:''}));
 const wallet=service.validateAccount({code:'MTN_MAIN',name:'MTN actual agent wallet',kind:'wallet',currency:'UGX',network:'MTN'});
 assert.equal(wallet.isDefault,true);assert.equal(wallet.operatorId,null);assert.throws(()=>service.validateAccount({...wallet,network:'Unknown'}));
 assert.equal(service.moduleForKind('cash'),'shared');assert.equal(service.moduleForKind('wallet'),'mobile_money');assert.equal(service.normalSide('transfer_clearing'),'credit');
});
test('dated actual evidence validates appropriate source, precision, review reference and stable idempotency',()=>{
 const input={kind:'checkpoint',actualBalance:'10.25',observedAt:new Date().toISOString(),evidenceType:'provider_app',evidenceReference:'PROVIDER-SCREEN-123',note:'Actual displayed wallet checked directly',idempotencyKey:randomUUID()};
 assert.equal(service.parseObservation(input,{kind:'wallet',currency:'USD'}).actualMinor,1025n);
 assert.equal(service.parseObservation({...input,evidenceType:'provider_sms'},{kind:'wallet',currency:'USD'}).evidenceType,'provider_sms');
 assert.throws(()=>service.parseObservation({...input,evidenceType:'cash_count'},{kind:'wallet',currency:'USD'}));
 assert.throws(()=>service.parseObservation({...input,observedAt:'2099-01-01T00:00:00.000Z'},{kind:'wallet',currency:'USD'}));
 assert.throws(()=>service.parseObservation({...input,idempotencyKey:'random'},{kind:'wallet',currency:'USD'}));
});
test('movement payloads retain exact counterparty economics and reject duplicate funds, malformed amounts and unscoped sources',()=>{
 const branchId=String(new mongoose.Types.ObjectId()),accountId=String(new mongoose.Types.ObjectId()),other=String(new mongoose.Types.ObjectId());
 const value=service.normalizeMovement({sourceType:'banking',sourceRef:'BANK:REFERENCE-123',branchId,legs:[],ledgerLines:[{currency:'USD',accountId,side:'debit',amountMinor:'123'},{currency:'USD',accountId:other,side:'credit',amountMinor:'123'}],description:'Actual internal account transfer'});
 assert.equal(value.legs.length,0);assert.equal(value.ledgerLines.length,2);
 assert.throws(()=>service.normalizeMovement({...value,legs:[{accountId,deltaMinor:'1'},{accountId,deltaMinor:'2'}]}));
 assert.throws(()=>service.normalizeMovement({...value,sourceType:'made_up'}));assert.throws(()=>service.normalizeMovement({...value,ledgerLines:[{currency:'USD',accountId,side:'credit',amountMinor:'-1'}]}));
});
test('fund movements and batches are append-only evidence and keys prevent duplicate application',()=>{
 for(const schema of [schemas.batchSchema,schemas.movementSchema]){
  assert.equal(schema.options.strict,'throw');assert.equal(schema.options.versionKey,false);
  for(const name of ['tenantId','branchId','sourceType','sourceRef'])assert.equal(schema.path(name).options.immutable,true);
 }
 assert(schemas.batchSchema.indexes().some(([key,options])=>key.sourceType===1&&key.sourceRef===1&&options.unique));
 assert(schemas.movementSchema.indexes().some(([key,options])=>key.accountId===1&&key.sequence===1&&options.unique));
 assert(schemas.accountSchema.indexes().some(([key,options])=>key.selectionKey===1&&options.unique));
});

test('unused money-account archival is limited to uninitialized, unposted accounts with no balance evidence',()=>{
 const base={kind:'wallet',code:'WRONG_MTN',status:'uninitialized',openingBalanceMinor:null,
  openingApprovedAt:null,openingObservationId:null,pendingOpeningId:null,lastObservationId:null,
  sequence:0,bookBalanceMinor:'0',reconciliationState:'unknown'};
 for(const kind of ['wallet','cash','bank','forex_stock'])
  assert.doesNotThrow(()=>service.assertUnusedAccountArchivable({...base,kind},'WRONG_MTN'));
 for(const changed of [
  {kind:'transfer_clearing'},{status:'active'},{status:'held'},{status:'archived'},
  {openingBalanceMinor:'0'},{openingApprovedAt:new Date()},{openingObservationId:new mongoose.Types.ObjectId()},
  {pendingOpeningId:new mongoose.Types.ObjectId()},{lastObservationId:new mongoose.Types.ObjectId()},
  {sequence:1},{bookBalanceMinor:'100'},{reconciliationState:'matched'}
 ])assert.throws(()=>service.assertUnusedWalletArchivable({...base,...changed},'WRONG_MTN'));
 assert.throws(()=>service.assertUnusedWalletArchivable(base,'ANOTHER_WALLET'),{status:400});
});
test('unused account archive and restore require owner permission and verified CSRF',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const routes=fs.readFileSync(path.resolve(__dirname,'../src/tenant/treasury/routes.js'),'utf8');
 const view=fs.readFileSync(path.resolve(__dirname,'../src/views/tenant/treasury/detail.ejs'),'utf8');
 assert.match(routes,/router\.post\('\/accounts\/:id\/archive',requirePermission\('treasury\.manage'\),throttle/);
 assert.match(view,/user\.role==='Tenant Owner'/);
 assert.match(view,/account\.status==='uninitialized'/);
 assert.match(view,/name="confirmCode"/);
 assert.match(view,/name="confirmCode" value="<%= account.code %>"/);
 assert.match(routes,/router\.post\('\/accounts\/:id\/restore',requirePermission\('treasury\.manage'\),throttle/);
 assert.match(view,/name="_csrf"/);
 assert.doesNotMatch(routes,/router\.(?:delete|get)\('\/accounts\/:id\/archive'/);
});
