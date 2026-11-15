'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const path=require('node:path');
const {formatUtcDate}=require('../src/utils/view');
const {platformMenu}=require('../src/services/menu.service');

const user={id:'507f1f77bcf86cd799439011',name:'Administrator',role:'Super Admin',permissions:['*']};
const layout=path.resolve(__dirname,'../src/views/layouts/dashboard.ejs');
function page(view,data){
  return ejs.renderFile(layout,{
    context:'platform',currentPath:'/platform/'+view,pageTitle:'Platform',pageSub:'Administration',
    tenant:null,user,menu:platformMenu(user),view:'../platform/'+view,data,
    flash:null,assetVersion:'test',csrfToken:'test',money:()=>'',formatUtcDate
  });
}
function dashboardData(recentAudits){
  return {tenants:[],totalTenants:0,activeTenants:0,suspendedTenants:0,appointmentCount:0,availableModuleCount:0,recentAudits};
}

test('UTC timestamps preserve valid dates and distinguish absent legacy dates from the Unix epoch',()=>{
  const valid=new Date('2026-11-03T12:00:00Z');
  assert.equal(formatUtcDate(valid),'2026-11-03T12:00:00.000Z');
  assert.equal(formatUtcDate('2026-11-03T15:00:00+03:00'),'2026-11-03T12:00:00.000Z');
  assert.equal(formatUtcDate(0),'1970-01-01T00:00:00.000Z');
  for(const value of [undefined,null,'','  ','invalid-date',new Date(NaN),NaN,Infinity,{},[],false]){
    assert.equal(formatUtcDate(value),'Unknown date');
  }
  assert.equal(formatUtcDate(undefined,'Not recorded'),'Not recorded');
  assert.equal(valid.toISOString(),'2026-11-03T12:00:00.000Z');
});

test('post-login dashboard and audit page retain legacy audit events with unknown dates without mutating records',async()=>{
  const events=Object.freeze([
    Object.freeze({action:'legacy.missing_date',recordId:'missing'}),
    Object.freeze({action:'legacy.null_date',recordId:'null',createdAt:null}),
    Object.freeze({action:'legacy.invalid_date',recordId:'invalid',createdAt:'invalid-date'}),
    Object.freeze({action:'tenant.created',recordId:'valid',createdAt:new Date('2026-11-03T12:00:00Z')})
  ]);
  const before=structuredClone(events);
  for(const [view,data] of [['dashboard/index',dashboardData(events)],['audit/index',{auditLogs:events}]]){
    const html=await page(view,data);
    assert.equal((html.match(/Unknown date/g)||[]).length,3);
    assert.match(html,/2026-11-03T12:00:00\.000Z/);
    assert.doesNotMatch(html,/1970-01-01/);
    for(const event of events)assert(html.includes(event.action),`missing event ${event.action} in ${view}`);
  }
  assert.deepEqual(events,before);
});

test('platform dashboard and audit page preserve their first-run empty states',async()=>{
  const dashboard=await page('dashboard/index',dashboardData([]));
  assert.match(dashboard,/No tenants yet/);
  assert.match(dashboard,/No activity to show yet/);
  const audit=await page('audit/index',{auditLogs:[]});
  assert.match(audit,/No recorded platform administration events/);
});

test('legacy tenant module display never invents an active entitlement',async()=>{
  for(const fields of [{},{enabledModules:null,moduleGrants:null},{enabledModules:'mobile_money',moduleGrants:{}}]){
    const tenant=Object.freeze({id:'507f1f77bcf86cd799439012',name:'Legacy workspace',slug:'legacy',plan:'agent',...fields});
    const before=structuredClone(tenant);
    const list=await page('tenants/index',{tenants:[tenant],plans:[]});
    assert.match(list,/0 available/);
    assert.match(list,/Unknown status/);
    const profile=await page('tenants/show',{
      tenant,modules:[{key:'mobile_money',name:'Mobile Money',icon:'fa-wallet'}],published:[]
    });
    assert.match(profile,/No published plan entitlement recorded/);
    assert.match(profile,/Not migrated \/ no entitlement/);
    assert.doesNotMatch(profile,/class="chip active"/);
    assert.deepEqual(tenant,before);
  }
});

test('only active saved subscription terms enable modules; a past-due workspace remains restricted',async()=>{
  const tenant={id:'507f1f77bcf86cd799439012',name:'Assigned workspace',slug:'assigned',plan:'agent',status:'active',setupStatus:'complete',
    enabledModules:['mobile_money'],moduleGrants:[],seatsReserved:1,branchCount:1,
    currentPlanName:'Agent Plan',currentPlanVersion:2,planAccessActive:true,currentModuleCount:1,
    subscription:{planCode:'agent',planName:'Agent Plan',planVersion:2,status:'granted',
      periodStart:new Date('2026-01-01T00:00:00Z'),periodEnd:new Date('2030-01-01T00:00:00Z'),
      modules:['mobile_money'],limits:{users:5,branches:2}}};
  const list=await page('tenants/index',{tenants:[tenant],plans:[]});
  assert.match(list,/1 available/);
  assert.match(list,/Agent Plan/);
  const profile=await page('tenants/show',{
    tenant,modules:[{key:'mobile_money',name:'Mobile Money',icon:'fa-wallet'}],published:[],effectivePlan:tenant.subscription,activeAddonGrants:[]
  });
  assert.match(profile,/class="chip active">Mobile Money · available/);
  const pastDue={...tenant,status:'past_due',planAccessActive:false,currentModuleCount:0};
  const restrictedList=await page('tenants/index',{tenants:[pastDue],plans:[]});
  assert.match(restrictedList,/0 available/);
  assert.match(restrictedList,/past due/);
  const restrictedProfile=await page('tenants/show',{
    tenant:pastDue,modules:[{key:'mobile_money',name:'Mobile Money',icon:'fa-wallet'}],published:[],effectivePlan:null,activeAddonGrants:[]
  });
  assert.doesNotMatch(restrictedProfile,/class="chip active"/);
});
