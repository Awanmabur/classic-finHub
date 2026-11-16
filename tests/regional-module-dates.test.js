'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const source=name=>fs.readFileSync(path.join(root,name),'utf8');
const workspaces=require('../src/tenant/services/operationWorkspace.service');
const operations=require('../src/tenant/services/operationsReports.service');
const analytics=require('../src/tenant/services/analytics.service');
const dashboard=require('../src/tenant/services/dashboardVolumes.service');
const businessTime=require('../src/utils/businessTime');
const day={from:'2026-11-17',to:'2026-11-17'};

test('Banking, Forex and Money Transfer use local midnight for workspace histories and daily groups',()=>{
 for(const moduleKey of ['banking','forex','money_transfer']){
  const ug=workspaces.filtersFor(moduleKey,day,'Africa/Kampala');
  assert.equal(ug.dateBounds.$gte.toISOString(),'2026-11-16T21:00:00.000Z');
  assert.equal(ug.dateBounds.$lt.toISOString(),'2026-11-17T21:00:00.000Z');
  const ss=workspaces.filtersFor(moduleKey,day,'Africa/Juba');
  assert.equal(ss.dateBounds.$gte.toISOString(),'2026-11-16T22:00:00.000Z');
  assert.equal(ss.dateBounds.$lt.toISOString(),'2026-11-17T22:00:00.000Z');
 }
 const contract=source('src/tenant/services/operationWorkspace.service.js');
 assert.match(contract,/timezone:timeZone/);
 assert.match(contract,/filtersFor\(key,query,timeZone\)/);
});
test('the shared reports accept branch-local dates without changing UTC persistence',()=>{
 const sources=[{key:'mobile_money'}];
 const selected=operations.parseFilters({...day,source:'all'},sources,'Africa/Juba');
 assert.equal(selected.dateRange.$gte.toISOString(),'2026-11-16T22:00:00.000Z');
 assert.equal(selected.timeZone,'Africa/Juba');
 for(const name of ['mobileMoney','cashShifts','moneyTransfer','banking','forex','expenses']){
  const adapter=source('src/tenant/reporting/adapters/'+name+'.js');
  assert(adapter.includes('timeZone:filters.timeZone')||adapter.includes('dateRange')||name==='expenses');
 }
 for(const name of ['moneyTransfer','banking','forex','cashDrawer','expenses']){
  const module=source('src/tenant/services/'+name+'.service.js');
  assert.match(module,/dateRange\|\|mobile\.dateBounds|createdAt:dateRange/);
 }
});
test('analytics uses complete local days, not fixed UTC 24h, and daylight-saving changes are safe',()=>{
 const now=new Date('2026-11-16T22:30:00.000Z');
 const ug=analytics.bounds(7,now,'Africa/Kampala');
 assert.equal(ug.end.toISOString(),'2026-11-16T21:00:00.000Z');
 assert.equal(ug.start.toISOString(),'2026-11-09T21:00:00.000Z');
 assert.equal((analytics.bounds(7,new Date('2026-03-30T12:00:00Z'),'Europe/Berlin').end-
   analytics.bounds(7,new Date('2026-03-30T12:00:00Z'),'Europe/Berlin').start)/3600000,167);
});
test('today on the main financial overview uses local day, preserves raw timestamps',()=>{
 const now=new Date('2026-11-16T22:30:00.000Z');
 assert.equal(dashboard.bounds(now,'Africa/Kampala').$gte.toISOString(),'2026-11-16T21:00:00.000Z');
 assert.equal(dashboard.bounds(now,'Africa/Juba').$gte.toISOString(),'2026-11-16T22:00:00.000Z');
 assert.equal(dashboard.bounds(now).$gte.toISOString(),'2026-11-16T00:00:00.000Z');
 const platform=source('src/platform/routes/index.js');
 const tenant=source('src/tenant/routes/index.js');
 assert.match(platform,/businessTimeZone:/);
 assert.match(tenant,/businessTimeZoneForBranch:/);
 assert.match(platform,/platform\.timezone\.changed/);
 assert.match(source('src/platform/models/PlatformAdmin.js'),/timeZone:/);
});
