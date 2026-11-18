'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const ejs=require('ejs');
const schema=require('../src/tenant/schemas/BankingInternalFx.schema').schema;
const fx=require('../src/tenant/services/bankingInternalFx.service');
const {permissionsFor}=require('../src/config/roles');
const {hasModuleForUser}=require('../src/tenant/services/moduleAccess.service');
const modules=['banking','forex','accounts'];
const owner={role:'Tenant Owner',permissions:['*'],allowedModules:modules};
test('Banking FX append-only record requires two accounts, approved rate and two journals',()=>{
 for(const field of ['tenantId','branchId','createdBy','customerId','sourceAccountId','destinationAccountId',
  'sourceCurrency','destinationCurrency','sourceAmountMinor','destinationAmountMinor',
  'rateId','rateVersion','rateDecimal','journalBatchId','journalIds','postedAt'])
  assert(schema.path(field).isRequired,field);
 assert(schema.indexes().some(([keys,opts])=>keys.idempotencyKey===1&&opts.unique));
 for(const op of ['updateOne','findOneAndUpdate','deleteOne','deleteMany'])
  assert(schema.s.hooks._pres.get(op)?.length,op+' cannot overwrite settled FX');
});
test('Banking FX access needs source and Forex module, customer accounts and appropriate role',()=>{
 const tenant={status:'active'};
 // Without a real tenant commercial grant, ordinary actors cannot access
 // financial modules. Even a forged permission array never grants a module.
 const forged={role:'Viewer',permissions:['*'],allowedModules:modules};
 assert.equal(fx.eligible(tenant,forged),false);
 const plain={role:'Banking Operator',permissions:permissionsFor('Banking Operator'),allowedModules:[]};
 assert.equal(fx.eligible(tenant,plain),false);
 assert.equal(hasModuleForUser(tenant,plain,'forex'),false);
});
test('Banking internal currency exchange template uses CSRF, evidence and two native currencies',async()=>{
 const filename=path.join(__dirname,'../src/views/tenant/banking/fx-exchange.ejs');
 const html=await ejs.renderFile(filename,{
  data:{accounts:[{_id:'507f1f77bcf86cd799439011',customerName:'Example Customer',
    accountNumber:'CUSTOMER-123456',currency:'UGX'}],
   rates:[{_id:'507f1f77bcf86cd799439012',revision:1,rateDecimal:'0.00027',
    fromCurrency:'UGX',toCurrency:'USD',side:'buy'}],
   records:[],idempotencyKey:'22222222-2222-4222-8222-222222222222'},
  csrfToken:'test-csrf',formatLocalDate:()=>'',user:owner
 });
 assert.match(html,/name="_csrf" value="test-csrf"/);
 assert.match(html,/name="confirmCustomerAuthority"/);
 assert.match(html,/name="rateChoice"/);
 assert.match(html,/action="\/tenant\/banking\/exchange\/preview"/);
 assert.match(html,/name="sourceAccountId"/);
 assert.match(html,/name="destinationAccountId"/);
 assert.match(html,/0\.00027/);
 assert.match(html,/internal financial-book transfer/);
 assert.doesNotMatch(html,/<script>alert/);
});
test('Banking FX code never claims that customer ledger transfer executes an external wire',()=>{
 const service=fs.readFileSync(path.join(__dirname,'../src/tenant/services/bankingInternalFx.service.js'),'utf8');
 assert.match(service,/NOT a bank wire/);
 assert.match(service,/treasury\.applyMovements/);
 assert.match(service,/sourceType:'forex'/);
 assert.match(service,/Insufficient posted customer balance/);
});

test('Banking FX final confirmation shows the exact two-currency quote and retains fixed idempotency',async()=>{
 const filename=path.join(__dirname,'../src/views/tenant/banking/fx-confirm.ejs');
 const html=await ejs.renderFile(filename,{csrfToken:'some-csrf',
  data:{review:{
   source:{_id:'507f1f77bcf86cd799439011',customerName:'Example Customer',currency:'UGX',accountNumber:'AC1234'},
   destination:{_id:'507f1f77bcf86cd799439012',currency:'USD',accountNumber:'AC5678'},
   sourceLabel:'UGX 2,000',destinationLabel:'USD 0.54',rate:{side:'buy',fromCurrency:'UGX',toCurrency:'USD'},
   rateDecimal:'0.00027',rateId:'507f1f77bcf86cd799439013',rateVersion:1,
   amount:'2000',evidenceReference:'INVOICE-12345',idempotencyKey:'22222222-2222-4222-8222-222222222222'
  }}
 });
 assert.match(html,/UGX 2,000/);
 assert.match(html,/USD 0.54/);
 assert.match(html,/Confirm and post both currency ledgers/);
 assert.match(html,/name="_csrf" value="some-csrf"/);
 assert.match(html,/name="idempotencyKey" value="22222222-2222-4222-8222-222222222222"/);
 assert.match(html,/name="confirmCustomerAuthority"/);
 assert.match(html,/action="\/tenant\/banking\/exchange"/);
});
