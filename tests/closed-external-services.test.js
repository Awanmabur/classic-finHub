'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const sms=require('../src/config/sms');const {tenantPath}=require('../src/config/storage');
test('unconfigured SMS never logs customer messages or pretends delivery',async()=>{
  await assert.rejects(sms.sendSms({to:'+256700000000',message:'OTP 123456'}),e=>e.status===503);
});
test('private storage namespace rejects traversal and unsafe tenant IDs',()=>{
  assert.equal(tenantPath('unit-agent','reports'),'/private/tenants/unit-agent/reports');
  assert.throws(()=>tenantPath('../etc','reports'));
  assert.throws(()=>tenantPath('unit-agent','../../secrets'));
});
