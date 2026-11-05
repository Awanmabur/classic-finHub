'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {chooseRecentAcknowledgement}=require('../src/tenant/services/recentAcknowledgement.service');

test('recent acknowledgement picks newest of authorized recorded data',()=>{
  const mobile=[{_id:'aaaaaaaaaaaaaaaaaaaaaaaa',createdAt:'2026-11-05T10:00:00Z'}];
  const transfers=[{_id:'bbbbbbbbbbbbbbbbbbbbbbbb',createdAt:'2026-11-05T11:00:00Z'}];
  const value=chooseRecentAcknowledgement({mobile,transfers});
  assert.equal(value.href,'/tenant/money-transfer/bbbbbbbbbbbbbbbbbbbbbbbb/acknowledgement');
  assert.match(value.label,/request acknowledgement/);
  assert.equal(value.recordedAt,'2026-11-05T11:00:00.000Z');
});

test('recent acknowledgements cannot use arbitrary links or missing identities',()=>{
  assert.equal(chooseRecentAcknowledgement(),null);
  assert.equal(chooseRecentAcknowledgement({mobile:[{_id:'../platform/tenants',createdAt:'2026-11-05'}]}),null);
  assert.equal(chooseRecentAcknowledgement({transfers:[{_id:'aaaaaaaaaaaaaaaaaaaaaaaa',createdAt:'invalid'}]}),null);
  assert.equal(chooseRecentAcknowledgement({mobile:[{_id:'aaaaaaaaaaaaaaaaaaaaaaaa',createdAt:'2026-11-05'}]}).href,
    '/tenant/mobile-money/aaaaaaaaaaaaaaaaaaaaaaaa/acknowledgement');
});
