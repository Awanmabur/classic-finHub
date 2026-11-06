'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),ejs=require('ejs');
const v=require('../src/tenant/customerAccounts/validation'),service=require('../src/tenant/customerAccounts/service');
const body={name:'  Jane   Doe ',phone:'+256 (700) 123-456',email:'JANE@example.invalid',identityNumber:'ID-12345',type:'Individual',nextOfKinName:'John Doe',nextOfKinPhone:'+256700987654',relationship:'Sibling',country:'Uganda',city:'Kampala',note:'Primary residence'};
const rejects=(call,status=400)=>assert.throws(call,error=>error.status===status);
test('Customer identity validation preserves approved fields and normalizes international contacts',()=>{
 const value=v.customer(body);assert.equal(value.name,'Jane Doe');assert.equal(value.normalizedName,'jane doe');assert.equal(value.phone,'+256700123456');assert.equal(value.email,'jane@example.invalid');assert.equal(value.nextOfKinPhone,'+256700987654');
 assert.equal(value.identityNumber,'ID-12345');assert.equal(value.country,'Uganda');assert.equal(value.note,'Primary residence');
 for(const patch of [{name:'<script>bad</script>'},{phone:'0700123456'},{email:'not-an-email'},{identityNumber:'<123>'},{type:'Admin'},{country:'256 Uganda'},{nextOfKinName:'',nextOfKinPhone:'+256700987654'},{note:'a'.repeat(501)},{name:['Jane']}])rejects(()=>v.customer({...body,...patch}));
});
test('Account intelligence accepts approved metadata while rejecting invented opening funds or overdrafts',()=>{
 const value=v.account({type:'Business Account',status:'pending',risk:'High',officer:'Teller One',purpose:'Retail trading',openingUGX:'0',openingUSD:'0.00',openingSSP:'0',openingKES:'0',overdraftLimit:'0'});
 assert.deepEqual(value,{type:'Business Account',status:'pending',risk:'High',officer:'Teller One',purpose:'Retail trading'});
 for(const field of ['overdraftLimit','openingUGX','openingUSD','openingSSP','openingKES','openingBalance'])for(const amount of ['1','-1','1e2','0.001'])rejects(()=>v.account({[field]:amount}));
 for(const patch of [{status:'paid'},{type:'Unknown'},{risk:'Trusted'},{purpose:'<img>'}])rejects(()=>v.account(patch));
});
test('Creation keys, stable references and keyset cursors reject malformed directory input',()=>{
 const key=crypto.randomUUID();assert.equal(v.key(key),key);rejects(()=>v.key('not-a-uuid'));rejects(()=>v.id('another-tenant'));rejects(()=>v.revision('-1'));
 assert.match(v.reference('','CUS'),/^CUS-[A-F0-9]{20}$/);assert.equal(v.reference('cus-test-123','CUS'),'CUS-TEST-123');rejects(()=>v.reference('short','CUS'));
 const row={_id:'507f1f77bcf86cd799439011',createdAt:new Date('2026-01-01T12:00:00Z')},cursor=v.nextCursor([row]);assert.deepEqual(v.cursor(cursor),{id:row._id,at:row.createdAt});
 rejects(()=>v.cursor('x'.repeat(257)));rejects(()=>v.cursor(Buffer.from(JSON.stringify({id:row._id,at:'bad date'})).toString('base64url')));
 assert.equal(v.pageFilter(cursor).$or[1]._id.$lt,row._id);
});
test('Ledger balance formatting remains exact across approved currencies and large minor amounts',()=>{
 assert.equal(service.formatMinor('12345','USD'),'USD 123.45');assert.equal(service.formatMinor('-105','SSP'),'SSP -1.05');assert.equal(service.formatMinor('100','KES'),'KSH 1.00');assert.equal(service.formatMinor('1234567','UGX'),'UGX 1,234,567');assert.equal(service.formatMinor('9999999999999999999999','USD'),'USD 99,999,999,999,999,999,999.99');assert.equal(service.formatMinor(null,'UGX'),'Unavailable');
});
test('Directory CSV excludes identity, next-of-kin and internal notes from its explicit export contract',()=>{
 assert.deepEqual(service.EXPORT_FIELDS,['reference','name','phone','email','type','country','city','status','createdAt']);assert.equal(service.MAX_EXPORT_ROWS,10000);
});
test('Customer form includes every approved section and field with CSRF and server creation key',async()=>{
 const html=await ejs.renderFile(path.join(__dirname,'../src/views/tenant/customer-accounts/form.ejs'),{csrfToken:'csrf-value',user:{name:'Teller One'},data:{formKind:'customer',formRecord:null,idempotencyKey:'creation-key'}});
 for(const text of ['Customer identity','Next of kin / emergency contact','Address and notes','Full name','Phone','Email','ID / Passport No.','Customer type','Customer reference','Next of kin name','Next of kin phone','Relationship','Country','City / area','Address / notes','Create customer'])assert(html.includes(text),text);
 assert.match(html,/name="_csrf" value="csrf-value"/);assert.match(html,/name="idempotencyKey" value="creation-key"/);assert(!html.includes('name="branchId"'));
});
test('Account form includes account intelligence and all four opening labels without a branch selector',async()=>{
 const html=await ejs.renderFile(path.join(__dirname,'../src/views/tenant/customer-accounts/form.ejs'),{csrfToken:'csrf-value',user:{name:'Teller One'},operationBranch:{name:'Kampala'},data:{formKind:'account',formRecord:null,idempotencyKey:'creation-key',customerChoices:[{_id:'507f1f77bcf86cd799439011',name:'Jane <img>',phone:'+256700123456',reference:'CUS-JANE'}]}});
 for(const text of ['Account owner','Account intelligence','Opening balances','Customer','Account number','Account type','Status','Overdraft limit','Account branch','Account officer','Purpose / source of funds','KYC risk level','Opening UGX','Opening USD','Opening SSP','Opening KSH','Create account'])assert(html.includes(text),text);
 assert(html.includes('Jane &lt;img&gt;'));assert(!html.includes('name="branchId"'));assert.match(html,/name="overdraftLimit" value="0" readonly/);assert.match(html,/data-customer-lookup/);
});
