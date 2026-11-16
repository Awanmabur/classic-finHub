'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const risk=require('../src/tenant/services/mobileMoneyRisk.service');
const source=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('ordinary entries produce no owner alert; high relative amounts and rapid repeats are risk notices not convictions',()=>{
 assert.deepEqual(risk.classify({currency:'UGX',amountMinor:'15000',priorFloatMinor:'5000000'}),[]);
 assert.deepEqual(risk.classify({currency:'UGX',amountMinor:'500000',priorFloatMinor:'900000'}),['large_relative_to_float']);
 assert.deepEqual(risk.classify({currency:'UGX',amountMinor:'50000',priorFloatMinor:'1000000',recentExactCount:2}),['rapid_repeat']);
 assert.deepEqual(risk.classify({currency:'UGX',amountMinor:'500000',priorFloatMinor:'900000',recentExactCount:3}),['large_relative_to_float','rapid_repeat']);
 assert.deepEqual(risk.classify({currency:'UGX',amountMinor:'500',priorFloatMinor:'1'}),[]);
 assert.throws(()=>risk.classify({currency:'BAD',amountMinor:'2000'}),/currency/);
});
test('new transactions finalize as internally recorded, not provider-verified or independently approved',()=>{
 const code=source('src/tenant/services/mobileMoney.service.js');
 const shift=source('src/tenant/services/cashDrawer.service.js');
 const schema=source('src/tenant/models/index.js');
 assert.match(code,/status:'pending_verification',reviewState:'recorded',riskFlags/);
 assert.match(code,/risk\.queueOwnerAlerts\(conn,session,created,operator,riskFlags\)/);
 assert.match(schema,/enum: \['awaiting_review','accepted','disputed','recorded'\]/);
 assert.match(shift,/reviewState:\{\$in:\['accepted','recorded'\]\}/);
 assert.match(code,/idempotencyKey/);
});
test('risk owner notifications use existing transactional mail queue; no add-on required and role protected',()=>{
 const notices=source('src/tenant/services/mobileMoneyRisk.service.js');
 const messages=source('src/tenant/schemas/NotificationMessage.schema.js');
 const worker=source('src/tenant/services/notification.service.js');
 const page=source('src/views/tenant/mobile-money/index.ejs');
 assert.match(notices,/source:'financial_exception'/);
 assert.match(notices,/emailState:'pending'/);
 assert.match(notices,/role:'Tenant Owner',status:'active'/);
 assert.match(worker,/row\.source==='financial_exception'/);
 assert.match(worker,/recipient\?\.role==='Tenant Owner'/);
 assert.match(messages,/financial_exception/);
 assert.match(page,/Transactions needing attention/);
 assert.match(page,/Acknowledge/);
 assert.doesNotMatch(page,/Independent internal review/);
});
