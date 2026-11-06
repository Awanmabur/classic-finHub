'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const ejs=require('ejs');
const path=require('node:path');
const mongoose=require('mongoose');
const config=require('../src/config/currencies');
const mobile=require('../src/tenant/services/mobileMoney.service');
const forex=require('../src/tenant/services/forex.service');
const banking=require('../src/tenant/services/banking.service');
const transfer=require('../src/tenant/services/moneyTransfer.service');
const branch=require('../src/tenant/services/branch.service');
const workspace=require('../src/tenant/services/operationWorkspace.service');
const branchId='507f1f77bcf86cd799439011',otherId='507f1f77bcf86cd799439012';

test('ISO persistence and approved currency labels do not introduce alias currencies',()=>{
 assert.deepEqual(config.currencyOptions.map(({code,label,scale})=>[code,label,scale]),[
  ['UGX','UGX',0],['USD','USD',2],['SSP','SSP',2],['KES','KSH',2]
 ]);
 assert(Object.isFrozen(config.currencies));assert(Object.isFrozen(config.currencyCodes));
 assert.equal(config.currencyLabel('KES'),'KSH');
 for(const code of config.currencyCodes)assert.equal(branch.validate({name:'Currency branch',code:'test-branch',currency:code},true).currency,code);
 for(const code of ['KSH','JPY','usd','SSP ',['USD']]){
  assert.throws(()=>branch.validate({name:'Currency branch',code:'test-branch',currency:code},true));
  assert.throws(()=>mobile.toMinor('1',code));
 }
});

test('USD and SSP entry, formatting and FX conversion retain exact cents and bounds',()=>{
 for(const code of ['USD','SSP']){
  assert.equal(mobile.toMinor('123456.78',code),12345678);
  assert.equal(mobile.toMinor('0.01',code),1);
  assert.equal(mobile.toMinor('100000000.00',code),10000000000);
  assert.throws(()=>mobile.toMinor('100000000.01',code));
  for(const value of ['1.001','1e2','-0.01','0','NaN'])assert.throws(()=>mobile.toMinor(value,code));
  assert.equal(mobile.formatMoneyMinor('-5',code),`${code} -0.05`);
  assert.equal(mobile.formatMoneyMinor('12345678901234567',code),`${code} 123,456,789,012,345.67`);
  assert.equal(forex.amountLabel('-5',code),`${code} -0.05`);
 }
 assert.equal(forex.converted(12345n,'USD','SSP',forex.rateScaled('123.45678901')),1524074n);
 assert.equal(forex.converted(100n,'SSP','UGX',forex.rateScaled('3.5')),4n,'Half-unit UGX quotes round once at target precision');
 assert.throws(()=>mobile.toMinor('1.01','UGX'));
});

test('transfer and banking accept exact USD/SSP amounts while rejecting unsupported currencies',()=>{
 for(const currency of ['USD','SSP']){
  const reference=banking.validateReference({customerName:'Currency customer',institutionName:'Example bank',last4:'1234',currency});
  assert.equal(reference.currency,currency);
  const bank=banking.validateRequest({kind:'deposit_request',sourceId:branchId,currency,amount:'12.34',note:'Recorded customer instruction',idempotencyKey:crypto.randomUUID()});
  assert.equal(bank.amountMinor,1234);
  const request=transfer.validateOrder({senderId:branchId,beneficiaryId:otherId,currency,amount:'12.34',fee:'0.01',idempotencyKey:crypto.randomUUID()});
  assert.equal(request.amountMinor,1234);assert.equal(request.feeMinor,1);
  for(const key of ['money_transfer','banking','forex'])assert.equal(workspace.filtersFor(key,{currency}).currency,currency);
 }
 for(const key of ['money_transfer','banking','forex'])assert.throws(()=>workspace.filtersFor(key,{currency:'KSH'}));
});

test('branch, cash, financial, ledger and operation schemas share supported persisted codes',()=>{
 const fields=[
  [require('../src/tenant/models/Branch'),'currency'],
  [require('../src/tenant/models/CashSession'),'currency'],
  [require('../src/tenant/schemas/BankReference.schema'),'currency'],
  [require('../src/tenant/schemas/BankingRequest.schema'),'currency'],
  [require('../src/tenant/schemas/TransferOrder.schema'),'currency'],
  ...Object.values(require('../src/tenant/ledger/schemas')).filter(value=>value instanceof mongoose.Schema).map(schema=>[schema,'currency']),
  ...['operation','evidence'].map(key=>[require('../src/tenant/financial/schemas')[key],'currency'])
 ];
 for(const [schema,field] of fields)assert.deepEqual(schema.path(field).enumValues,[...config.currencyCodes]);
 const conn=mongoose.createConnection();
 assert.deepEqual(require('../src/tenant/models').mobileTransactionModel(conn).schema.path('currency').enumValues,[...config.currencyCodes]);
 assert.deepEqual(require('../src/tenant/schemas/ForexQuote.schema').path('fromCurrency').enumValues,[...config.forexCurrencyCodes]);
 // Broadening manual accounting does not guess a network's SMS wording.
 assert.deepEqual(require('../src/tenant/schemas/SmsInbox.schema').path('fields.currency').enumValues,['UGX','KES']);
 conn.destroy();
});

test('cash shift presentation converts minor units once, including signed subunit variance',async()=>{
 for(const currency of ['USD','SSP','KES']){
  const html=await ejs.renderFile(path.join(__dirname,'../src/views/tenant/mobile-money/shift-detail.ejs'),{
   formatMoneyMinor:mobile.formatMoneyMinor,csrfToken:'test',data:{canSubmit:false,canReview:false,
    shift:{_id:branchId,currency,status:'submitted',createdAt:new Date(),submittedAt:new Date(),
     openingMinor:'12345',provisionalMovementMinor:'0',expectedClosingMinor:'12345',declaredClosingMinor:'12340',varianceMinor:'-5',recordCount:0,closeHistory:[]}}
  });
  assert(html.includes(`${currency} 123.45`));assert(html.includes(`${currency} -0.05`));
  assert(!html.includes(`${currency} 12345`),'A raw minor-unit integer must never be labelled as a major currency amount');
 }
});
