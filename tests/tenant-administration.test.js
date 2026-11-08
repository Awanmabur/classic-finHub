'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const path=require('node:path');
const {permissionsFor,INVITABLE,requiresTenantMfa}=require('../src/config/roles');
const {assignableModules,validateAssignments,hasModuleForUser,canUse}=require('../src/tenant/services/moduleAccess.service');
const branch=require('../src/tenant/services/branch.service');
const tenantAdmin=require('../src/platform/services/tenantAdmin.service');
const requireModule=require('../src/middleware/requireModule');
const {tenantMenu,platformMenu}=require('../src/services/menu.service');
const {tenantUserModel,branchModel,staffInviteModel,mobileTransactionModel}=require('../src/tenant/models');
const mongoose=require('mongoose');
const {entitledTenant}=require('./helpers/entitlement');
const tenant=entitledTenant({slug:'unit-agent',enabledModules:['mobile_money','notifications']});
const id='507f1f77bcf86cd799439011';
const owner={id,role:'Tenant Owner',permissions:['*'],allowedModules:['mobile_money']};
const operator={id,role:'Mobile Money Operator',permissions:permissionsFor('Mobile Money Operator'),allowedModules:['mobile_money'],branchId:id};
test('tenant owner can assign only subscribed live modules; no raw permission grants',()=>{
  assert.deepEqual(assignableModules(tenant,'Mobile Money Operator'),['mobile_money','notifications']);
  assert.deepEqual(validateAssignments(tenant,'Mobile Money Operator','mobile_money'),['mobile_money']);
  assert.deepEqual(validateAssignments(tenant,'Mobile Money Operator',[]),[]);
  assert.throws(()=>validateAssignments(tenant,'Mobile Money Operator','banking'),e=>e.status===403);
  assert.deepEqual(validateAssignments(tenant,'Mobile Money Operator','notifications'),['notifications']);
  assert.throws(()=>validateAssignments(tenant,'Mobile Money Operator',['mobile_money','mobile_money']),e=>e.status===400);
  assert.equal(canUse(tenant,operator,'mobile_money','mobile_money.cash_in'),true);
  assert.equal(canUse(tenant,{...operator,allowedModules:[]},'mobile_money','mobile_money.cash_in'),false);
  assert.equal(canUse(tenant,{...operator,allowedModules:['banking']},'mobile_money','mobile_money.cash_in'),false);
  assert.equal(canUse(tenant,{...operator,permissions:permissionsFor('Viewer')},'mobile_money','mobile_money.cash_in'),false);
  assert.equal(hasModuleForUser({...tenant,plan:'finance'},owner,'mobile_money'),false);
});
test('module middleware refuses access without assigned module, even with a privileged role string',()=>{
  const check=requireModule('mobile_money');let passed=false;
  const denied={status(code){assert.equal(code,403);return this;},send(message){assert.match(message,/not assigned/);return this;}};
  check({tenant,user:{...operator,allowedModules:[]}},denied,()=>passed=true);
  assert.equal(passed,false);
  check({tenant,user:operator},denied,()=>passed=true);
  assert.equal(passed,true);
});
test('Branch Manager is MFA protected, scoped to permitted branch staff, and cannot approve financial entries',()=>{
  assert(INVITABLE.includes('Branch Manager'));
  assert(requiresTenantMfa('Branch Manager'));
  const manager={role:'Branch Manager',permissions:permissionsFor('Branch Manager'),branchId:id,allowedModules:['mobile_money']};
  assert(permissionsFor('Branch Manager').includes('branches.view'));
  assert(!permissionsFor('Branch Manager').includes('users.manage'));
  assert(!permissionsFor('Branch Manager').includes('mobile_money.review'));
  const menu=tenantMenu(tenant,manager).flatMap(g=>g.items.map(x=>x.href));
  assert(menu.includes('/tenant/branches'));
  assert(menu.includes('/tenant/users'));
  assert(permissionsFor('Branch Manager').includes('users.manage_branch'));
  assert(!permissionsFor('Branch Manager').includes('users.manage'));
  assert(menu.includes('/tenant/mobile-money/cash-in'));
  assert(!menu.includes('/tenant/workspace/subscription'));
});
test('branch and platform status validators reject invalid changes before touching a database',()=>{
  assert.deepEqual(branch.validate({name:'Kampala HQ',code:'kla-hq',currency:'UGX',address:'Kitende'},true),{name:'Kampala HQ',code:'kla-hq',currency:'UGX',currencies:['UGX','USD','SSP','KES'],address:'Kitende'});
  assert.throws(()=>branch.validate({name:'Branch',code:'../admin',currency:'USD'},true),e=>e.status===400);
  assert.throws(()=>branch.validate({name:'A',code:'a',currency:'UGX'},true),e=>e.status===400);
  assert.throws(()=>branch.validId('../other'),e=>e.status===400);
  assert.throws(()=>tenantAdmin.validateStatusChange({status:'deleted',reason:'Approved support operation'}),e=>e.status===400);
  assert.throws(()=>tenantAdmin.validateStatusChange({status:'suspended',reason:'No'}),e=>e.status===400);
  assert.equal(tenantAdmin.validateStatusChange({status:'suspended',reason:'Risk review completed'}).status,'suspended');
  assert.throws(()=>tenantAdmin.validateProfile({name:'Valid name',phone:'javascript:alert(1)',reason:'Verified profile update'}),e=>e.status===400);
  assert.equal(tenantAdmin.validateProfile({name:'Revised Tenant',phone:'+256 700 000 000',reason:'Case 124 confirmed'}).name,'Revised Tenant');
});
test('tenant financial records have a branch field and staff invitations preserve explicit branch/module scope',()=>{
  const conn={models:{},model(name,schema){const entry={schema};this.models[name]=entry;return entry;}};
  const user=tenantUserModel(conn).schema;
  assert(user.path('branchId'));
  assert(user.path('allowedModules'));
  assert(mobileTransactionModel(conn).schema.path('branchId'));
  assert(branchModel(conn).schema.path('code').options.immutable);
  assert(staffInviteModel(conn).schema.path('allowedModules'));
  assert.equal(staffInviteModel(conn).schema.path('branchId').isRequired,true);
});
function page(view,data,user,context='tenant'){
  const layout=path.join(__dirname,'../src/views/layouts/dashboard.ejs');
  const t=context==='tenant'?{slug:'unit-agent',name:'Unit Agent',status:'active',plan:'agent',enabledModules:['mobile_money'],seatsReserved:2}:null;
  const u=user||owner;
  return ejs.renderFile(layout,{ context,pageTitle:'Admin test',pageSub:'Role access',currentPath:context==='tenant'?'/tenant/'+view:'/platform/'+view,
    tenant:t,user:u,menu:context==='tenant'?tenantMenu(t,u):platformMenu(u),view:`../${context}/${view}`,data,flash:null,
    assetVersion:'test',csrfToken:'abcd',money:()=>'',amountFromMinor:()=>'' });
}
test('branch page renders actual create/edit/archive actions only for Tenant Owner',async()=>{
  const details={_id:new mongoose.Types.ObjectId(id),name:'Main Branch',code:'main-branch',status:'active',currency:'UGX',address:'Kitende'};
  const data={branches:[details],plan:{limits:{branches:3}},canManage:true};
  const html=await page('branches/index',data,owner);
  assert.match(html,/action="\/tenant\/branches"/);
  assert.match(html,/action="\/tenant\/branches\/[a-f0-9]{24}\/update"/);
  assert.match(html,/Archive/);
  const manager={...operator,role:'Branch Manager',permissions:permissionsFor('Branch Manager')};
  const readOnly=await page('branches/index',{...data,canManage:false},manager);
  assert.doesNotMatch(readOnly,/action="\/tenant\/branches"/);
  assert.doesNotMatch(readOnly,/\/archive"/);
});
test('staff page renders scoped invitations, audited edits and invitation revocation',async()=>{
  const data={users:[{_id:id,name:'Operator',email:'operator@example.invalid',role:'Mobile Money Operator',status:'active',branchId:id,allowedModules:['mobile_money']}],
    invitations:[{_id:id,email:'pending@example.invalid',role:'Viewer',branchId:id,expiresAt:new Date('2026-12-01')}],
    roles:INVITABLE,branches:[{_id:id,name:'Main Branch',status:'active'}],assignable:['mobile_money'],plan:{limits:{users:12}}};
  const html=await page('users/index',data,owner);
  assert.match(html,/name="branchId"/);
  assert.match(html,/name="allowedModules"/);
  assert.match(html,/\/users\/[a-f0-9]{24}\/edit/);
  const edit=await page('users/edit',{account:data.users[0],roles:INVITABLE,branches:data.branches,assignable:['mobile_money']},owner);
  assert.match(edit,/\/users\/[a-f0-9]{24}\/update/);
  assert.match(edit,/name="allowedModules"/);
  assert.match(html,/\/users\/invitations\/[a-f0-9]{24}\/revoke/);
  assert.match(edit,/Save access changes/);
});
test('platform dashboard and audit panel are distinct and render actual administrative data',async()=>{
  const admin={name:'Administrator',role:'Super Admin',permissions:['*']};
  const now=new Date('2026-11-03T12:00:00Z');
  const dash=await page('dashboard/index',{totalTenants:105,tenants:[],appointmentCount:8,activeTenants:82,suspendedTenants:3,availableModuleCount:1,recentAudits:[{createdAt:now,action:'tenant.created',recordId:id}]},admin,'platform');
  assert.match(dash,/105/);assert.match(dash,/Platform operations/);assert.match(dash,/tenant\.created/);
  const audit=await page('audit/index',{auditLogs:[{createdAt:now,actorId:id,action:'tenant.status_changed',moduleKey:'tenants',recordId:id}]},admin,'platform');
  assert.match(audit,/tenant\.status_changed/);
  assert(!/Pending admin implementation/.test(audit));
});
