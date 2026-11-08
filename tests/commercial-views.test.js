'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const path=require('node:path');
const {tenantMenu,platformMenu}=require('../src/services/menu.service');
const {entitledTenant}=require('./helpers/entitlement');
const {permissionsFor}=require('../src/config/roles');
const {formatUtcDate}=require('../src/utils/view');
const tenant=entitledTenant({name:'Test Tenant',slug:'test-tenant',email:'test@example.invalid',branchCount:1,seatsReserved:2,
  dbName:'classicfin_tenant_test_tenant_db'});
const tData={tenant:{...tenant,id:'507f1f77bcf86cd799439011'},plans:[],modules:[],published:[{
  code:'agent',version:1,name:'Agent',limits:{users:12,branches:3},currency:'USD',priceMonthlyMinor:14900,publishedAt:new Date()
}]};
const base=path.resolve(__dirname,'../src/views/layouts/dashboard.ejs');
async function page(context,view,data,user){
 const platform=context==='platform';
 return ejs.renderFile(base,{context,currentPath:`/${context}/${view}`,pageTitle:'Billing',pageSub:'Audited subscriptions',
  tenant:platform?null:tenant,user,menu:platform?platformMenu(user):tenantMenu(tenant,user),
  view:`../${context}/${view}/index`,data,flash:null,assetVersion:'test',csrfToken:'unitcsrf',money:()=>'',amountFromMinor:()=>'',formatUtcDate});
}
test('platform subscriptions render saved tenants and safe management links',async()=>{
 const admin={id:'507f1f77bcf86cd799439012',name:'Admin',role:'Super Admin',permissions:['*']};
 const html=await page('platform','subscriptions',{tenants:[{...tenant,_id:tData.tenant.id}]},admin);
 assert.match(html,/Subscriptions and trials/);assert.match(html,/Manage tenant/);
 assert.match(html,/agent v1/);
 const managed=await page('platform','tenants/show',tData,admin).catch(async()=>{
  // 'tenants/show' is a direct EJS template (not /index).
  return ejs.renderFile(base,{context:'platform',currentPath:'/platform/tenants',pageTitle:'Tenant',pageSub:'Control',
   tenant:null,user:admin,menu:platformMenu(admin),view:'../platform/tenants/show',data:tData,
   flash:null,assetVersion:'test',csrfToken:'unitcsrf',money:()=>'',amountFromMinor:()=>'',formatUtcDate});
 });
 assert.match(managed,/subscription\/grant/);assert.match(managed,/subscription\/revoke/);
 assert.match(managed,/name="_csrf" value="unitcsrf"/);
 assert.match(managed,/20–600 characters/);
});
test('tenant billing shows persisted usage without fabricated invoices or charge actions',async()=>{
 const owner={id:'507f1f77bcf86cd799439013',role:'Tenant Owner',name:'Owner',permissions:permissionsFor('Tenant Owner')};
 const data={subscription:tenant.subscription,plan:{name:'Agent',modules:['mobile_money'],limits:tenant.subscription.limits},usage:4,period:'2026-11'};
 const html=await page('tenant','billing',data,owner);
 assert.match(html,/Recorded Mobile Money operations/);
 assert.match(html,/4 \/ 5000/);
 assert.match(html,/NOT enabled/);
 assert.doesNotMatch(html,/action="\/tenant\/billing\/pay"/);
});
