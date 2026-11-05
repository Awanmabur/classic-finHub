'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const disabled = err => err && err.status === 501 && /No records or funds were changed/.test(err.message);
test('Legacy transfer, banking, forex and ledger services never fabricate financial success',()=>{
  const operations=[
    ['moneyTransfer',['sendMoney','payoutByPin']],['banking',['deposit','withdraw']],
    ['forex',['buy','sell']],['ledger',['postEntry']]
  ];
  for(const [name,methods] of operations){
    const service=require(`../src/tenant/services/${name}.service`);
    for(const method of methods) assert.throws(()=>service[method]({amount:100,currency:'UGX'}),disabled,`${name}.${method}`);
  }
});
test('Unimplemented CRUD services cannot silently return fake data or fake success',()=>{
  for(const name of ['expense','customer','analytics','role','report']) {
    const service=require(`../src/tenant/services/${name}.service`);
    for(const method of ['list','create','update'])assert.throws(()=>service[method](),disabled,`${name}.${method}`);
  }
  const billing=require('../src/platform/services/billing.service');
  assert.throws(()=>billing.recordPayment('i',100),disabled);
});
test('Unimplemented jobs fail when invoked instead of printing a successful fake ready message',async()=>{
  for(const name of ['paymentStatus','reportGeneration']) {
    const job=require(`../src/jobs/${name}.job`);
    await assert.rejects(job.run(),/not implemented; no work was completed/);
  }
});

test('Implemented backup job still fails safely if its separate key is not configured',async()=>{
  const previous=process.env.BACKUP_KEY_FILE;
  delete process.env.BACKUP_KEY_FILE;
  try{await assert.rejects(require('../src/jobs/backup.job').run(),/BACKUP_KEY_FILE/);}finally{
    if(previous!==undefined)process.env.BACKUP_KEY_FILE=previous;
  }
});

test('Former cash-shift and acknowledgement placeholders now expose real services rather than fake CRUD',()=>{
  const cash=require('../src/tenant/services/cashDrawer.service');
  const day=require('../src/tenant/services/daySession.service');
  const receipt=require('../src/tenant/services/receipt.service');
  assert.equal(day.open,cash.open);
  assert.equal(typeof day.submit,'function');
  assert.equal(typeof receipt.acknowledgement,'function');
  assert.throws(()=>receipt.acknowledgement({}),{status:400});
});

test('Notifications background job requires a trusted tenant cursor and mailer, not a public trigger',async()=>{
 await assert.rejects(require('../src/jobs/notification.job').run(),/Authenticated tenant cursor/);
});
