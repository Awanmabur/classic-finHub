'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const path=require('node:path');
const {entitledTenant}=require('./helpers/entitlement');
const {permissionsFor,INVITABLE,requiresTenantMfa}=require('../src/config/roles');
const {hasModuleForUser,assignableModules}=require('../src/tenant/services/moduleAccess.service');
const {tenantMenu}=require('../src/services/menu.service');
const analytics=require('../src/tenant/services/analytics.service');
const report=require('../src/tenant/services/operationsReports.service');
const subs=require('../src/platform/services/moduleSubscriptions.service');
const now=new Date('2026-11-03T15:40:00Z');
const oid='507f1f77bcf86cd799439011';
const grant=(moduleKey)=>({moduleKey,status:'granted',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2028-01-01'),currency:'USD',limits:{users:8,branches:3,recordsPerMonth:0}});
const tenant=(keys)=>entitledTenant({plan:'modular',enabledModules:[],moduleGrants:keys.map(grant)});
const actor=(role,modules,branchId=oid)=>({id:'507f1f77bcf86cd799439012',role,branchId,allowedModules:modules,permissions:permissionsFor(role)});
function denied(fn,status){assert.throws(fn,e=>e.status===status);}
test('Advanced Analytics is independently subscribable without Operations Reports and cannot grant transaction access',()=>{
 const t=tenant(['analytics']);
 assert(subs.eligible('analytics'));
 const analyst=actor('Analytics Analyst',['analytics']);
 assert(hasModuleForUser(t,analyst,'analytics'));
 assert(!hasModuleForUser(t,analyst,'reports'));
 assert.deepEqual(analytics.sourcesFor(t,analyst).map(s=>s.key),['workspace']);
 assert.deepEqual(report.sourcesFor(t,analyst),[]);
 assert(tenantMenu(t,analyst).some(g=>g.items.some(i=>i.href==='/tenant/analytics')));
 assert(!tenantMenu(t,analyst).some(g=>g.items.some(i=>i.href==='/tenant/reports')));
 assert(!analyst.permissions.includes('mobile_money.cash_in'));
 assert(!analyst.permissions.includes('forex.quotes.create'));
 assert(INVITABLE.includes('Analytics Analyst'));
 assert(requiresTenantMfa('Analytics Analyst'));
 assert.equal(subs.validateGrant({moduleKey:'analytics',days:30,users:3,branches:1,recordsPerMonth:0,
  reason:'Approved separate analytics access following tenant review.'}).moduleKey,'analytics');
});
test('Analytics requires own entitlement, and each module source requires its own entitlement and staff assignment',()=>{
 const t=tenant(['analytics','mobile_money','forex']);
 const analyst=actor('Analytics Analyst',['analytics','forex']);
 assert.deepEqual(analytics.sourcesFor(t,analyst).map(s=>s.key),['workspace','cash_shifts','forex']);
 assert(assignableModules(t,'Analytics Analyst').includes('mobile_money'));
 assert(!analytics.sourcesFor(t,actor('Analytics Analyst',['analytics'])).some(s=>s.key==='forex'));
 assert.deepEqual(analytics.sourcesFor(tenant(['mobile_money']),analyst),[]);
 denied(()=>analytics.filtersFor({source:'mobile_money'},analytics.sourcesFor(t,analyst)),403);
 denied(()=>analytics.filtersFor({source:'../../other'},analytics.sourcesFor(t,analyst)),403);
});
test('cash analytics requires a subscribed and assigned financial source',()=>{
 for(const key of ['money_transfer','banking','forex','expenses']){
  const t=tenant(['analytics',key]),assigned=actor('Analytics Analyst',['analytics',key]);
  assert(analytics.sourcesFor(t,assigned).some(source=>source.key==='cash_shifts'),key);
  assert(!analytics.sourcesFor(t,actor('Analytics Analyst',['analytics'])).some(source=>source.key==='cash_shifts'),'Unassigned cash source must not leak');
  const revoked={...t,moduleGrants:t.moduleGrants.map(g=>g.moduleKey===key?{...g,status:'revoked'}:g)};
  assert(!analytics.sourcesFor(revoked,assigned).some(source=>source.key==='cash_shifts'),'Revoked cash source must disappear');
  assert(!assigned.permissions.includes('treasury.view'),'Aggregate visibility never grants wallet control');
 }
 assert.deepEqual(analytics.sourcesFor(tenant(['analytics']),actor('Analytics Analyst',['analytics'])).map(source=>source.key),['workspace']);
});
test('Analytics enforces branch scope and exact bounded UTC comparison periods',()=>{
 const range=analytics.bounds(7,now);
 assert.equal(range.start.toISOString(),'2026-10-27T00:00:00.000Z');
 assert.equal(range.end.toISOString(),'2026-11-03T00:00:00.000Z');
 assert.equal(range.previousStart.toISOString(),'2026-10-20T00:00:00.000Z');
 const sources=[{key:'workspace'}];
 for(const days of ['0','1','31','100','-7','7days'])denied(()=>analytics.filtersFor({days},sources),400);
 assert.equal(analytics.filtersFor({days:'30',source:'workspace'},sources).days,30);
 for(const value of [null,'broken',new Date('garbage')])denied(()=>analytics.bounds(7,value),400);
 assert.equal(report.scopeFor(actor('Analytics Analyst',['analytics'])).branchId,oid);
 denied(()=>report.scopeFor(actor('Analytics Analyst',['analytics'],null)),403);
});
test('Analytics change rates handle no baseline, zero activity, and count overflow safely',()=>{
 assert.equal(analytics.change(12,10),'+20%');
 assert.equal(analytics.change(8,10),'-20%');
 assert.equal(analytics.change(0,0),'0%');
 assert.equal(analytics.change(5,0),'New activity');
 assert.equal(analytics.countOf([{count:5},{count:8}]),13);
 denied(()=>analytics.countOf([{count:-1}]),422);
 denied(()=>analytics.countOf([{count:'5'}]),422);
 denied(()=>analytics.countOf([{count:Number.MAX_SAFE_INTEGER},{count:1}]),422);
});
test('Analytics compares scoped audit data across both periods and leaves unused chart sources out',async()=>{
 const called=[];
 const conn={models:{SecureAuditEvent:{aggregate:pipeline=>{
  called.push(pipeline);
  assert.equal(pipeline[0].$match['metadata.branchId'],oid);
  if(pipeline[1].$group._id==='$action')return Promise.resolve([{_id:'staff.invited',count:3}]);
  return {option:async()=>[{_id:'2026-11-02',count:3},{_id:'2026-10-26',count:3}]};
 }}}};
 const user=actor('Analytics Analyst',['analytics']);
 const output=await analytics.generate(conn,tenant(['analytics']),user,{days:'7'},now);
 assert.equal(output.data[0].current,3);
 assert.equal(output.data[0].previous,3); // test adapter returns fixed mock each period
 assert.equal(output.trend.days.length,7);
 assert.deepEqual(output.trend.days.at(-1),{date:'2026-11-02',current:3,previousDate:'2026-10-26',previous:3});
 assert.equal(output.trend.days[0].current,0);
 assert.deepEqual(output.trend.activities,[{label:'staff.invited',count:3}]);
 assert.equal(output.data[0].change,'0%');
 assert.equal(called.length,3);
 assert.match(output.note,/same activity can appear/i);
 assert.deepEqual(output.sources.map(source=>source.key),['workspace']);
 const exported=await analytics.generate(conn,tenant(['analytics']),user,{days:'7'},now,'UTC',{charts:false});
 assert.equal(exported.trend,null);
 assert.equal(called.length,5);
});
test('Analytics CSV neutralizes spreadsheet formulas and outputs no personal data',()=>{
 const content=analytics.csv({from:'2026-10-28',to:'2026-11-03',data:[{label:'=HYPERLINK("evil")',current:1,previous:0,change:'New activity'}]});
 assert(content.startsWith('\ufeff'));
 assert(content.includes("'=HYPERLINK"));
 assert(!content.includes('"=HYPERLINK'));
});
test('Analytics dashboard escapes user data, and viewer has no fake export control',async()=>{
 const base={sources:[{key:'workspace',label:'Workspace activity'}],filters:{source:'all',days:7},
  data:[{label:'<img src=x onerror=alert(1)>',key:'workspace',current:5,previous:3,change:'+66.7%',
   breakdown:[{activity:'<script>alert(1)</script>',status:'recorded',currency:'—',count:5}]},
   {label:'Forex',key:'forex',current:4,previous:2,change:'+100%',breakdown:[]}],
  trend:{key:'workspace',days:[{date:'2026-11-03',current:5,previousDate:'2026-10-27',previous:3}],
   currencies:[{label:'UGX',count:3},{label:'KSH',count:2}],activities:[],statuses:[]},from:'2026-10-28',to:'2026-11-03',
  previousFrom:'2026-10-21',previousTo:'2026-10-27',note:'No settlement implied.'};
 const file=path.join(__dirname,'../src/views/tenant/analytics/index.ejs');
 const editable=await ejs.renderFile(file,{data:{insights:base,canExport:true}});
 assert.match(editable,/\/tenant\/analytics\/export\.csv/);
 assert.match(editable,/&lt;img src=x/);
 assert.match(editable,/&lt;script&gt;/);
 assert(!editable.includes('<script>alert(1)</script>'));
 assert.match(editable,/Daily activity/);
 assert.match(editable,/By currency/);
 assert.match(editable,/Daily totals/);
 assert.match(editable,/data-analytics-day aria-pressed="true"/);
 assert.match(editable,/<canvas[^>]+data-analytics-trend-line/);
 assert.match(editable,/aria-label="Previous date"/);
 assert.match(editable,/data-current="5" data-previous="3"/);
 assert.match(editable,/analyticsSourceDifference/);
 assert.match(editable,/--segments:var\(--chart-slice-0\) 0% 60%,var\(--chart-slice-1\) 60% 100%/);
 assert.match(editable,/>KSH<\/span>[\s\S]*?>2<\/strong>[\s\S]*?>40%<\/small>/);
 const viewer=await ejs.renderFile(file,{data:{insights:base,canExport:false}});
 assert(!viewer.includes('/tenant/analytics/export.csv'));
});
