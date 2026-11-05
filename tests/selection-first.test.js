'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const ejs = require('ejs');
const options = require('../src/utils/selectionOptions');
const transfer = require('../src/tenant/services/moneyTransfer.service');
const { modules } = require('../src/data/store');
const views = path.join(__dirname,'../src/views');
const render = (file,locals)=>ejs.renderFile(path.join(views,file),locals);

test('country selector uses canonical country IDs and rejects invented country codes',()=>{
  const list=options.countryOptions();
  assert(list.length>=240);
  assert.equal(list.length,new Set(list.map(c=>c.code)).size);
  assert(list.some(c=>c.code==='SS')); // South Sudan
  assert(list.some(c=>c.code==='UG'));
  assert(list.some(c=>c.code==='GB'));
  assert(options.isCountryCode('ug'));
  assert(!options.isCountryCode('ZZ'));
  assert(!options.isCountryCode('__proto__'));
  assert(!options.isCountryCode(['UG']));
  const base={kind:'sender',fullName:'Jane Doe',phone:'+256701234567',country:'ug'};
  assert.equal(transfer.validateContact(base).country,'UG');
  assert.throws(()=>transfer.validateContact({...base,country:'ZZ'}),{status:400});
});

test('public modules are individually selectable without disabled or forged products',()=>{
  const published=options.publicModuleOptions();
  assert(published.length>=8);
  assert(!published.some(m=>m.key==='customer_portal'));
  assert.deepEqual(options.parsePublicModuleSelection(['mobile_money','reports']),['mobile_money','reports']);
  assert.deepEqual(options.parsePublicModuleSelection('forex'),['forex']);
  assert.deepEqual(options.parsePublicModuleSelection(),[]);
  assert.deepEqual(options.parsePublicModuleSelection('Money Transfer + Mobile Money'),['money_transfer','mobile_money']);
  assert.deepEqual(options.parsePublicModuleSelection('Not sure yet'),[]);
  for(const input of [['mobile_money','mobile_money'],['customer_portal'],['fraud_module'],[{'x':'y'}],
    new Array(published.length+1).fill('reports')]){
    assert.throws(()=>options.parsePublicModuleSelection(input));
  }
  assert.equal(modules.length,published.length+1);
});

test('bank institution selection reuses a tenant-scoped existing name or requires explicit new details',()=>{
  const refs=[{institutionName:'Example Bank'},{institutionName:'Example Bank'},
    {institutionName:'  Another Bank  '},{institutionName:''}];
  const available=options.bankInstitutionOptions(refs);
  assert.deepEqual(available,['Another Bank','Example Bank']);
  const selected=options.resolveBankInstitution({institutionChoice:'Example Bank',institutionName:'ignored'},available);
  assert.equal(selected.institutionName,'Example Bank');
  const newOne=options.resolveBankInstitution({institutionChoice:'__new__',institutionName:'New Local Bank'},available);
  assert.equal(newOne.institutionName,'New Local Bank');
  assert.throws(()=>options.resolveBankInstitution({institutionChoice:'Other Tenant Bank'},available),{status:400});
  assert.throws(()=>options.resolveBankInstitution({institutionChoice:['Example Bank']},available),{status:400});
  assert.equal(options.resolveBankInstitution({institutionName:'Existing API Client'},available).institutionName,'Existing API Client');
});

test('transfer contact create and edit forms render selectable country names, not freeform country codes',async()=>{
  const id='507f1f77bcf86cd799439011';
  const data={canManage:true,selectedBranchId:id,branches:[{_id:id,name:'Main'}],countryOptions:options.countryOptions(),contacts:[]};
  const html=await render('tenant/money-transfer/contacts.ejs',{user:{role:'Money Transfer Operator'},data,csrfToken:'csrf'});
  assert.match(html,/<select[^>]+name="country"/);
  assert.match(html,/<option value="SS"[^>]*>South Sudan \(SS\)<\/option>/);
  assert.match(html,/<option value="UG">Uganda \(UG\)<\/option>/);
  assert.doesNotMatch(html,/<input[^>]+name="country"/);
  const edit=await render('tenant/money-transfer/contact-edit.ejs',{
    data:{contact:{_id:id,kind:'sender',fullName:'Jane',phone:'+256701234567',country:'SS',branchId:id},countryOptions:options.countryOptions()},csrfToken:'csrf'
  });
  assert.match(edit,/<option value="SS" selected>South Sudan \(SS\)<\/option>/);
  assert.doesNotMatch(edit,/<input[^>]+name="country"/);
});

test('bank account directory selects known institutions and has an explicit new-institution escape hatch',async()=>{
  const id='507f1f77bcf86cd799439011';
  const data={canManage:true,selectedBranchId:id,branches:[],institutions:['Example Bank'],references:[]};
  const html=await render('tenant/banking/accounts.ejs',{data,user:{role:'Banking Operator'},csrfToken:'csrf'});
  assert.match(html,/<select name="institutionChoice"/);
  assert.match(html,/<option value="Example Bank">Example Bank<\/option>/);
  assert.match(html,/name="institutionName"/);
  const edit=await render('tenant/banking/account-edit.ejs',{data:{reference:{_id:id,customerName:'Jane',institutionName:'Example Bank',last4:'1234',currency:'UGX'},institutions:['Example Bank']},csrfToken:'csrf'});
  assert.match(edit,/<option value="Example Bank" selected>Example Bank<\/option>/);
});

test('public pages list individual modules and preserve the approved login fields',async()=>{
  const params={appUrl:'https://classicfin.example',cspNonce:'nonce',assetVersion:'v1',csrfToken:'csrf',selectableModules:options.publicModuleOptions(),flash:null,plans:[]};
  const homepage=await render('original/home.ejs',params);
  const signup=await render('original/signup.ejs',params);
  assert.match(homepage,/name="modules" value="money_transfer"/);
  assert.match(homepage,/name="modules" value="reports"/);
  assert.doesNotMatch(homepage,/name="modules" value="customer_portal"/);
  assert.match(signup,/name="modules" type="checkbox" value="forex"/);
  assert.doesNotMatch(signup,/name="modules" type="checkbox" value="customer_portal"/);
  const signin=await render('original/signin.ejs',params);
  assert.match(signin,/type="email" name="email"/);
  assert.match(signin,/type="password" name="password"/);
  assert.doesNotMatch(signin,/name="(tenant|role|workspaceId)"/);
});

test('bounded business validity periods are selectable and continue to obey backend range checks',()=>{
  const f=require('node:fs');
  for(const [file,field] of [
    ['tenant/money-transfer/index.ejs','validDays'],['tenant/banking/index.ejs','validDays'],
    ['tenant/forex/index.ejs','validHours'],['tenant/forex/index.ejs','validMinutes'],
    ['tenant/approvals/index.ejs','expiresHours']
  ]){
    const template=f.readFileSync(path.join(views,file),'utf8');
    assert.match(template,new RegExp(`<select[^>]*name="${field}"`));
    assert.doesNotMatch(template,new RegExp(`<input[^>]*name="${field}"`));
  }
  assert.equal(transfer.validateOrder({senderId:'507f1f77bcf86cd799439011',beneficiaryId:'507f1f77bcf86cd799439012',amount:'100',fee:'0',currency:'UGX',idempotencyKey:crypto.randomUUID(),validDays:'30'}).validDays,30);
  assert.throws(()=>transfer.validateOrder({senderId:'507f1f77bcf86cd799439011',beneficiaryId:'507f1f77bcf86cd799439012',amount:'100',fee:'0',currency:'UGX',idempotencyKey:crypto.randomUUID(),validDays:'31'}),{status:400});
});

test('transaction selectors align with branch currency rather than offering invalid alternatives',async()=>{
  const id='507f1f77bcf86cd799439011';
  const user={id:'507f1f77bcf86cd799439012',role:'Money Transfer Operator',branchId:id,permissions:['money_transfer.create','mobile_money.cash_in']};
  const branch={_id:id,name:'Nairobi',currency:'KES',status:'active'};
  const transferData={records:{items:[],nextCursor:null},queue:[],branches:[branch],selectedBranchId:id,
    contacts:[{_id:'507f1f77bcf86cd799439013',kind:'sender',fullName:'Sender',country:'KE'},
      {_id:'507f1f77bcf86cd799439014',kind:'beneficiary',fullName:'Receiver',country:'KE'}],
    canCreate:true,canReview:false,idempotencyKey:crypto.randomUUID(),formatMoneyMinor:(amount,currency)=>currency+amount};
  const transferHtml=await render('tenant/money-transfer/index.ejs',{data:transferData,user,csrfToken:'csrf'});
  assert.match(transferHtml,/<select[^>]+name="currency"[^>]*>\s*<option value="KES">KES<\/option>/);
  assert.doesNotMatch(transferHtml,/<select[^>]+name="currency"[^>]*>\s*<option value="UGX">UGX<\/option>/);
  const bankingData={branches:[branch],selectedBranchId:id,references:[{_id:'507f1f77bcf86cd799439013',institutionName:'Bank',customerName:'A',last4:'1234'}],
    records:{items:[],nextCursor:null},queue:[],canCreate:true,canReview:false,idempotencyKey:crypto.randomUUID(),formatMoneyMinor:(amount,currency)=>currency+amount};
  const bankingHtml=await render('tenant/banking/index.ejs',{data:bankingData,user:{...user,role:'Banking Operator'},csrfToken:'csrf'});
  assert.match(bankingHtml,/<select[^>]+name="currency"[^>]*>\s*<option value="KES">KES<\/option>/);
  assert.doesNotMatch(bankingHtml,/<select[^>]+name="currency"[^>]*>\s*<option value="UGX">UGX<\/option>/);
  const mobileHtml=await render('tenant/mobile-money/index.ejs',{data:{branches:[branch],canRecord:true,canReview:false,
    idempotencyKey:crypto.randomUUID(),summary:{total:0,recent:[]}},user:{...user,role:'Tenant Owner',permissions:['*']},
    money:()=>'',amountFromMinor:()=>'',csrfToken:'csrf'});
  assert.match(mobileHtml,/data-currency-target="mobileMoneyCurrency"/);
  assert.match(mobileHtml,/data-currency="KES"/);
  assert.match(mobileHtml,/id="mobileMoneyCurrency"/);
});

test('selected approval deadline presets remain bounded, with explicit custom override',()=>{
  const fs=require('node:fs');
  const html=fs.readFileSync(path.join(views,'tenant/approvals/index.ejs'),'utf8');
  assert.match(html,/customExpiresHours/);
  assert.match(html,/\[1,2,4,8,12,24,48,72,96,168,336,720\]/);
  const approvals=require('../src/tenant/services/approvals.service');
  const base={code:'office_review',name:'Office Review',category:approvals.CATEGORIES[0],steps:[approvals.ROLES[0]],expiresHours:'72'};
  assert.equal(approvals.policyInput(base).expiresHours,72);
  assert.equal(approvals.policyInput({...base,expiresHours:'720'}).expiresHours,720);
  assert.throws(()=>approvals.policyInput({...base,expiresHours:'721'}),{status:400});
});
