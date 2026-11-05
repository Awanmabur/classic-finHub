'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {entitledTenant}=require('./helpers/entitlement');
const subs=require('../src/platform/services/moduleSubscriptions.service');
const {hasModule,hasModuleForUser,assignableModules}=require('../src/tenant/services/moduleAccess.service');
const report=require('../src/tenant/services/operationsReports.service');
const {permissionsFor}=require('../src/config/roles');
const {models}=require('mongoose');
const T=require('../src/platform/models/Tenant');
const now=new Date();const tomorrow=new Date(now.getTime()+86400000);
const yesterday=new Date(now.getTime()-86400000);
const longEnd=new Date(now.getTime()+360*86400000);
function grant(moduleKey,overrides={}){return {moduleKey,status:'granted',generation:1,periodStart:yesterday,periodEnd:tomorrow,
  priceMonthlyMinor:3900,currency:'USD',limits:{users:5,branches:1,recordsPerMonth:moduleKey==='mobile_money'?100:0},...overrides};}
function modular(overrides={}){const base=entitledTenant({plan:'modular',enabledModules:[],moduleGrants:[]});return {...base,status:'active',
  subscription:{...base.subscription,periodEnd:yesterday},...overrides};}
function user(role='Reports Analyst',mods=['reports'],branchId='507f1f77bcf86cd799439011'){
 return {id:'507f1f77bcf86cd799439012',role,permissions:permissionsFor(role),allowedModules:mods,branchId};
}
test('Reports operates without Mobile Money or base-plan entitlement',()=>{
 const t=modular({moduleGrants:[grant('reports')]});
 assert.equal(hasModule(t,'reports'),true);assert.equal(hasModule(t,'mobile_money'),false);
 assert.equal(hasModuleForUser(t,user(),'reports'),true);
 assert.deepEqual(report.sourcesFor(t,user()).map(s=>s.key),['workspace']);
 assert.deepEqual(report.sourcesFor(t,user('Reports Analyst',[])),[]);
 assert.throws(()=>report.parseFilters({source:'mobile_money'},report.sourcesFor(t,user())),e=>e.status===403);
 assert.equal(require('../src/platform/services/commercial.service').limitsFor(t).users,5);
});
test('Mobile Money can be subscribed to without Reports',()=>{
 const t=modular({moduleGrants:[grant('mobile_money')]});
 assert.equal(hasModule(t,'mobile_money'),true);assert.equal(hasModule(t,'reports'),false);
 const operator=user('Mobile Money Operator',['mobile_money']);
 assert(hasModuleForUser(t,operator,'mobile_money'));
 assert(!report.sourcesFor(t,operator).length);
});
test('Reports Analyst can receive a reporting-source assignment without obtaining a transaction permission',()=>{
 const t=modular({moduleGrants:[grant('reports'),grant('mobile_money')]});
 assert(assignableModules(t,'Reports Analyst').includes('reports'));
 assert(assignableModules(t,'Reports Analyst').includes('mobile_money'));
 const analyst=user('Reports Analyst',['reports','mobile_money']);
 assert.deepEqual(report.sourcesFor(t,analyst).map(s=>s.key),['workspace','mobile_money','cash_shifts']);
 assert(!analyst.permissions.includes('mobile_money.cash_in'));
 assert(!analyst.permissions.includes('mobile_money.view'));
 assert(!analyst.permissions.includes('*'));
});
test('revoked, expired and suspended module entitlements never grant access',()=>{
 const g=grant('reports');
 for(const t of [modular({moduleGrants:[{...g,status:'revoked'}]}),
  modular({moduleGrants:[{...g,periodEnd:yesterday}]}),
  modular({moduleGrants:[g],status:'suspended'}),modular({moduleGrants:[{...g,generation:0}]})])
  assert.equal(hasModule(t,'reports'),false);
});
test('manual module grants enforce catalog availability and hardened terms',()=>{
 assert.equal(subs.validateGrant({moduleKey:'reports',days:'30',users:'5',branches:'1',recordsPerMonth:'0',reason:'Verified organization request with a manual commercial review.'}).priceMonthlyMinor,3900);
 const input={moduleKey:'mobile_money',days:30,users:6,branches:2,recordsPerMonth:2000,reason:'This request has been approved for controlled use by the operator.'};
 assert.equal(subs.validateGrant(input).limits.recordsPerMonth,2000);
 for(const change of [{moduleKey:'analytics'},{days:0},{users:0},{branches:0},{recordsPerMonth:-1},{reason:'short'}])
  assert.throws(()=>subs.validateGrant({...input,...change}));
 assert.throws(()=>subs.validateGrant({...input,moduleKey:'reports',recordsPerMonth:2}));
 assert(subs.eligible('banking'));assert(subs.eligible('forex'));
});
test('standalone tenant schema persists separate module snapshots',()=>{
 const tenant=new T({name:'Module Tenant',slug:'module-tenant',dbName:'classicfin_tenant_module_tenant_db',email:'owner@example.invalid',plan:'modular',status:'active',moduleGrants:[grant('reports'),grant('mobile_money')]});
 assert.equal(tenant.validateSync(),undefined);
 assert.equal(tenant.moduleGrants.length,2);
 assert.equal(tenant.moduleGrants[0].moduleKey,'reports');
});
test('reporting limits dates, branch scoping, and spreadsheet formula injection',()=>{
 assert.deepEqual(report.scopeFor(user('Tenant Owner')),{});
 assert.equal(report.scopeFor(user()).branchId,'507f1f77bcf86cd799439011');
 assert.throws(()=>report.scopeFor(user('Reports Analyst',['reports'],null)),e=>e.status===403);
 assert.throws(()=>report.parseFilters({from:'2026-01-01',to:'2026-12-01'},[{key:'workspace'}]));
 const csv=report.csv({rows:[{module:'Workspace',activity:'=HYPERLINK("oops")',status:'recorded',currency:'—',count:1,volume:'—',fees:'—'}]});
 assert(csv.startsWith('\ufeff'));assert(csv.includes("'=HYPERLINK"));assert(!csv.includes('"=HYPERLINK'));
});
test('reports aggregate real tenant audit events without exposing individual names',async()=>{
 let pipeline;
 const fake={aggregate:async p=>{pipeline=p;return [{_id:'staff.activated',count:2}];}};
 try{
  const result=await report.workspaceSource({models:{SecureAuditEvent:fake}},{$gte:yesterday,$lt:tomorrow},{branchId:'507f1f77bcf86cd799439011'});
  assert.equal(pipeline[0].$match['metadata.branchId'],'507f1f77bcf86cd799439011');
  assert.deepEqual(result.map(x=>x.activity),['staff.activated']);
  assert.equal(result[0].count,2);
 }finally{ /* no globals modified */ }
});
test('monthly usage for standalone Mobile Money is metered independently of base-plan counters',async()=>{
 const commerce=require('../src/platform/services/commercial.service');
 const t=modular({_id:'507f1f77bcf86cd799439011',moduleGrants:[grant('mobile_money',{generation:7,limits:{users:5,branches:1,recordsPerMonth:2}})]});
 let last;
 const Model={findOneAndUpdate:async(filter,update,options)=>{last={filter,update,options};return {quantity:1};}};
 await commerce.reserveUsage(t,'mobile_money_records',{test:true},new Date(),Model);
 assert.equal(last.filter.metric,'addon_mobile_money_records');
 assert.equal(last.filter.generation,1000000007);
 assert.equal(last.filter.quantity.$lt,2);
 await assert.rejects(commerce.reserveUsage({...t,moduleGrants:[]},'mobile_money_records',{test:true}),e=>e.status===403);
});
test('Reports Analyst role is allowed to be invited and requires MFA',()=>{
 const {checkStaff}=require('../src/tenant/services/staff.service');
 const {requiresTenantMfa}=require('../src/config/roles');
 assert.equal(checkStaff({name:'Finance Reporter',email:'finance@example.invalid',role:'Reports Analyst'}).role,'Reports Analyst');
 assert.equal(requiresTenantMfa('Reports Analyst'),true);
});
