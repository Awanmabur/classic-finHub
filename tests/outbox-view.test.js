'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');
const {platformMenu}=require('../src/services/menu.service');
const file=path.join(__dirname,'../src/views/platform/operations/queue.ejs');
const counts={pending:2,processing:1,accepted:8,dead:1};
const status={counts,liveWorkers:0,recent:[{_id:'507f1f77bcf86cd799439011',createdAt:new Date('2026-11-03'),
  type:'subscription.revoked',state:'dead',attempts:8,maxAttempts:8,failureCode:'provider_timeout',
  payload:{to:'topsecret@example.invalid'}}]};
test('platform queue view is safe, protected by form CSRF and exposes no recipient address',()=>{
  const html=ejs.render(fs.readFileSync(file,'utf8'),{data:{status},csrfToken:'test-csrf-token'},{filename:file});
  assert.match(html,/No recent worker heartbeat/);
  assert.match(html,/name="_csrf" value="test-csrf-token"/);
  assert.match(html,/Dead-letter/);
  assert.doesNotMatch(html,/topsecret@example.invalid/);
  assert.doesNotMatch(html,/leaseToken/);
  assert.match(html,/subscription.revoked/);
});
test('queue management appears only in authenticated platform menu',()=>{
  assert(platformMenu({permissions:['*']}).some(g=>g.items.some(item=>item.href==='/platform/operations/queue')));
  assert.deepEqual(platformMenu({permissions:['dashboard.view']}),[]);
});
