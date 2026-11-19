'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),phone=require('../src/utils/phoneCountry');
const request=value=>({get:()=>value});
test('client-supplied GeoIP is ignored unless an overwriting trusted edge is explicitly configured',()=>{assert.deepEqual(phone.defaults(request('UG'),{}),{country:'SS',dialCode:'+211'});const input={TRUST_PROXY:'1',GEO_COUNTRY_HEADER:'cf-ipcountry',GEO_COUNTRY_HEADERS_TRUSTED:'true'};assert.deepEqual(phone.defaults(request('FR'),input),{country:'FR',dialCode:'+33'});for(const value of ['XX','T1',['UG'],'ZZ',''])assert.equal(phone.defaults(request(value),input).country,'SS');assert.equal(phone.defaults(request('UG'),{...input,TRUST_PROXY:'0'}).country,'SS');assert.equal(phone.defaults(request('UG'),{...input,GEO_COUNTRY_HEADER:'x-forwarded-for'}).country,'SS');});
test('local phone numbers use the selected country and explicit international numbers retain their code',()=>{assert.equal(phone.normalize('0700 123 456','UG'),'+256700123456');assert.equal(phone.normalize('+254 712 345678','SS'),'+254712345678');assert.equal(phone.normalize('not a phone','SS'),'notaphone');});

test('phone normalization never passes arrays or objects to the phone parser',()=>{
 for(const country of [['SS'],{},false,12,null])assert.equal(phone.normalize('0921234567',country),'+211921234567');
 assert.equal(phone.normalize('0700 123 456','ug'),'+256700123456');
});

test('Mobile Money local phone uses provider wallet country rather than default South Sudan',()=>{
 for(const [network,currency,local,expected] of [
  ['MTN','UGX','0771 234 567','+256771234567'],
  ['Airtel','UGX','0700 123 456','+256700123456'],
  ['MTN SSD','SSP','0921 234 567','+211921234567'],
  ['M-Pesa','KES','0712 345678','+254712345678']
 ]){
  const country=phone.mobileMoneyCountry(network,currency,'SS');
  assert.equal(phone.normalize(local,country),expected,network+' '+currency);
 }
 assert.equal(phone.normalize('+254 712 345678',phone.mobileMoneyCountry('MTN','UGX')),'+254712345678');
 assert.equal(phone.mobileMoneyCountry('M-Pesa','KES'),'KE');
 assert.equal(phone.mobileMoneyCountry('Africell','USD','SS'),'SS');
});
