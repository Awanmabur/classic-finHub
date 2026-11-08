'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const path=require('node:path');
const {formatUtcDate}=require('../src/utils/view');
const {tenantMenu,platformMenu}=require('../src/services/menu.service');
const {effectiveSubscription,planForTenant}=require('../src/platform/services/commercial.service');
const {activeGrants}=require('../src/platform/services/moduleSubscriptions.service');
const Tenant=require('../src/platform/models/Tenant');
const tenantResolver=require('../src/middleware/tenantResolver');
const {entitledTenant}=require('./helpers/entitlement');
const id='507f1f77bcf86cd799439012';
const owner={id,name:'Owner',role:'Tenant Owner',permissions:['*']};
const admin={id,name:'Administrator',role:'Super Admin',permissions:['*']};
const layout=path.resolve(__dirname,'../src/views/layouts/dashboard.ejs');
const datedTenant=entitledTenant({_id:id,id,name:'Legacy workspace',slug:'legacy-workspace',seatsReserved:1,branchCount:0});
function render(context,view,tenant,data){
  const user=context==='tenant'?owner:admin;
  return ejs.renderFile(layout,{
    context,currentPath:`/${context}/${view}`,pageTitle:'Subscription',pageSub:'Recorded terms',
    tenant:context==='tenant'?tenant:null,user,menu:context==='tenant'?tenantMenu(tenant,user):platformMenu(user),
    view:`../${context}/${view}`,data,flash:null,csrfToken:'test',assetVersion:'test',money:()=>'',formatUtcDate
  });
}
function billingData(tenant){
  return {subscription:tenant.subscription,plan:planForTenant(tenant),usage:0,transferUsage:0,bankUsage:0,forexUsage:0,period:'2026-11',grants:activeGrants(tenant)};
}

test('billing and platform tenant profiles display unknown legacy subscription dates without activating access',async()=>{
  for(const periodEnd of [undefined,null,'invalid-date',new Date(NaN)]){
    const tenant={...datedTenant,subscription:{...datedTenant.subscription,periodEnd}};
    const before=structuredClone(tenant);
    assert.equal(effectiveSubscription(tenant),null);
    const billing=await render('tenant','billing/index',tenant,billingData(tenant));
    assert.match(billing,/Term ends<\/span><b>Unknown date<\/b>/);
    assert.match(billing,/Active modules<\/span><b>0<\/b>/);
    const profile=await render('platform','tenants/show',tenant,{tenant,modules:[],published:[]});
    assert.match(profile,/Expires<\/span><b>Unknown date<\/b>/);
    assert.doesNotMatch(billing,/1970-01-01/);
    assert.doesNotMatch(profile,/1970-01-01/);
    assert.deepEqual(tenant,before);
    assert.equal(effectiveSubscription(tenant),null);
  }
});

test('platform profiles retain grants with missing or invalid dates while tenant access excludes them',async()=>{
  for(const periodEnd of [undefined,null,'invalid-date',new Date(NaN)]){
    const grant={moduleKey:'mobile_money',status:'granted',generation:1,periodStart:new Date('2026-01-01'),periodEnd,
      currency:'USD',priceMonthlyMinor:5000,limits:{users:1,branches:1,recordsPerMonth:100}};
    const tenant={...datedTenant,subscription:undefined,enabledModules:[],moduleGrants:[grant]};
    const before=structuredClone(tenant);
    assert.deepEqual(activeGrants(tenant),[]);
    const profile=await render('platform','tenants/show',tenant,{tenant,modules:[],published:[]});
    assert.match(profile,/mobile_money \(granted\)<\/span><b>Unknown date<\/b>/);
    const billing=await render('tenant','billing/index',tenant,billingData(tenant));
    assert.match(billing,/No standalone module grants are active/);
    assert.match(billing,/No active term/);
    assert.deepEqual(tenant,before);
    assert.deepEqual(activeGrants(tenant),[]);
  }
});

test('valid subscription and grant dates keep their existing date-only display',async()=>{
  const grant={moduleKey:'mobile_money',status:'granted',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01'),
    currency:'USD',priceMonthlyMinor:5000,limits:{users:1,branches:1,recordsPerMonth:100}};
  const tenant={...datedTenant,moduleGrants:[grant]};
  const billing=await render('tenant','billing/index',tenant,billingData(tenant));
  assert.match(billing,/Term ends<\/span><b>2030-01-01<\/b>/);
  assert.match(billing,/Until 2030-01-01 · USD 50\.00\/mo/);
  const profile=await render('platform','tenants/show',tenant,{tenant,modules:[],published:[]});
  assert.match(profile,/Expires<\/span><b>2030-01-01<\/b>/);
  assert.match(profile,/mobile_money \(granted\)<\/span><b>2030-01-01<\/b>/);
});

test('invalid subscription dates still redirect reads to billing and block financial writes',async t=>{
  const tenant={...datedTenant,subscription:{...datedTenant.subscription,periodEnd:'invalid-date'}};
  const before=structuredClone(tenant);
  t.mock.method(Tenant,'findOne',()=>({lean:async()=>tenant}));
  async function request(method,path){
    const req={method,path,session:{tenantId:id,tenantUserId:owner.id}};
    const result={next:false,status:null,location:null,message:null};
    const res={redirect(status,location){Object.assign(result,{status,location});return this;},
      status(status){result.status=status;return this;},send(message){result.message=message;return this;}};
    await tenantResolver(req,res,error=>{assert.ifError(error);result.next=true;});
    return result;
  }
  assert.deepEqual(await request('GET','/dashboard'),{next:false,status:303,location:'/tenant/billing',message:null});
  const write=await request('POST','/mobile-money/cash-in');
  assert.equal(write.next,false);
  assert.equal(write.status,403);
  assert.match(write.message,/No changes were made/);
  const billing=await request('GET','/billing');
  assert.equal(billing.next,true);
  assert.equal(billing.status,null);
  assert.deepEqual(tenant,before);
});
