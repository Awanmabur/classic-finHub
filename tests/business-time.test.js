'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const time=require('../src/utils/businessTime');
const source=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('Uganda, South Sudan and Kenya are not treated as UTC display timestamps',()=>{
 assert.equal(time.defaultZone('UGX'),'Africa/Kampala');
 assert.equal(time.defaultZone('SSP'),'Africa/Juba');
 assert.equal(time.defaultZone('KES'),'Africa/Nairobi');
 const instant='2026-11-16T22:30:00.000Z';
 assert.equal(time.localDay(instant,'Africa/Kampala'),'2026-11-17');
 assert.equal(time.localDay(instant,'Africa/Juba'),'2026-11-17');
 assert.equal(time.startOfDay('2026-11-17','Africa/Kampala').toISOString(),'2026-11-16T21:00:00.000Z');
 // South Sudan has used UTC+02 since February 2021.
 assert.equal(time.startOfDay('2026-11-17','Africa/Juba').toISOString(),'2026-11-16T22:00:00.000Z');
 assert.equal(time.startOfDay('2026-11-17','Africa/Nairobi').toISOString(),'2026-11-16T21:00:00.000Z');
});
test('today and custom day bounds apply the branch-local calendar and remain UTC instants',()=>{
 const window=time.dayBounds({},'Africa/Kampala',90,new Date('2026-11-16T22:30:00.000Z'));
 assert.equal(window.from,'2026-11-17');
 assert.equal(window.to,'2026-11-17');
 assert.equal(window.$gte.toISOString(),'2026-11-16T21:00:00.000Z');
 assert.equal(window.$lt.toISOString(),'2026-11-17T21:00:00.000Z');
 const juba=time.dayBounds({from:'2026-11-16',to:'2026-11-17'},'Africa/Juba');
 assert.equal(juba.$gte.toISOString(),'2026-11-15T22:00:00.000Z');
 assert.equal(juba.$lt.toISOString(),'2026-11-17T22:00:00.000Z');
 assert.throws(()=>time.dayBounds({from:'2026-02-30',to:'2026-03-01'},'Africa/Juba'));
 assert.throws(()=>time.dayBounds({from:'2026-11-17'},'Africa/Juba'));
});
test('day bounds follow DST changes and ambiguous or nonexistent local payout times are rejected',()=>{
 const spring=time.dayBounds({from:'2026-03-29',to:'2026-03-29'},'Europe/Berlin');
 assert.equal((spring.$lt-spring.$gte)/3600000,23);
 const autumn=time.dayBounds({from:'2026-10-25',to:'2026-10-25'},'Europe/Berlin');
 assert.equal((autumn.$lt-autumn.$gte)/3600000,25);
 assert.equal(time.parseLocalDateTime('2026-11-16T15:30','Africa/Kampala').toISOString(),'2026-11-16T12:30:00.000Z');
 assert.equal(time.parseLocalDateTime('2026-11-16T15:30','Africa/Juba').toISOString(),'2026-11-16T13:30:00.000Z');
 assert.throws(()=>time.parseLocalDateTime('2026-03-29T02:30','Europe/Berlin'));
 assert.throws(()=>time.parseLocalDateTime('2026-10-25T02:30','Europe/Berlin'));
});
test('financial mobile money records keep immutable tariff versions and distinct fee/income reporting',()=>{
 const service=source('src/tenant/services/mobileMoney.service.js');
 const snapshot=source('src/tenant/pricing/networkTariffSnapshot.js');
 const reports=source('src/tenant/services/mobileMoneyWorkspace.service.js');
 const rates=source('src/tenant/pricing/networkTariffService.js');
 const payouts=source('src/tenant/pricing/commissionPayoutService.js');
 assert.match(service,/\.transactionEstimates\(/);
 assert.match(snapshot,/immutable:true/);
 assert.match(rates,/businessTime\.localDay\(timestamp,businessTime\.forBranch\(branch\)\)/);
 assert.match(reports,/Agent commission estimate \(unreceived\)/);
 assert.match(reports,/Provider customer charge estimate \(not income\)/);
 assert.match(payouts,/businessTime\.forBranch\(receivingBranch\)/);
 assert.match(payouts,/businessTime\.parseLocalDateTime\(input\.creditedAt,timeZone\)/);
 assert.doesNotMatch(rates,/applyMovements\(/);
});
