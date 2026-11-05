'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const ejs=require('ejs');
const {managedRoles,directoryFilter,staffFilter,enforceAssignment,canManage}=require('../src/tenant/services/staffPolicy');
const {permissionsFor}=require('../src/config/roles');
const {tenantMenu}=require('../src/services/menu.service');
const {plans,modules}=require('../src/data/store');
const owner={id:'507f1f77bcf86cd799439011',role:'Tenant Owner',permissions:['*']};
const manager={id:'507f1f77bcf86cd799439012',role:'Branch Manager',permissions:permissionsFor('Branch Manager'),branchId:'507f1f77bcf86cd799439013',allowedModules:['mobile_money']};
const otherBranch='507f1f77bcf86cd799439014';
const {entitledTenant}=require('./helpers/entitlement');
const tenant=entitledTenant({slug:'unit-agent',name:'Unit Agent',enabledModules:['mobile_money'],seatsReserved:3});
const staff={role:'Mobile Money Operator',branchId:manager.branchId,allowedModules:['mobile_money']};
function denied(fn){assert.throws(fn,e=>e.status===403);}
test('Branch Manager can administer operators/viewers only in their own branch',()=>{
  assert(canManage(owner));assert(canManage(manager));assert(!canManage({...manager,role:'Auditor'}));
  assert.deepEqual(managedRoles(manager),['Money Transfer Operator','Banking Operator','Forex Operator','Mobile Money Operator','Approval Requester','Viewer']);
  assert.deepEqual(staffFilter(manager),{role:{$in:['Money Transfer Operator','Banking Operator','Forex Operator','Mobile Money Operator','Approval Requester','Viewer']},branchId:manager.branchId});
  assert.deepEqual(directoryFilter(manager),{branchId:manager.branchId,role:{$in:['Money Transfer Operator','Banking Operator','Forex Operator','Mobile Money Operator','Approval Requester','Viewer']}});
  assert.doesNotThrow(()=>enforceAssignment(tenant,manager,staff.role,staff.branchId,staff.allowedModules));
  denied(()=>enforceAssignment(tenant,manager,staff.role,otherBranch,staff.allowedModules));
  denied(()=>enforceAssignment(tenant,manager,'Reconciliation Officer',manager.branchId,staff.allowedModules));
  denied(()=>enforceAssignment(tenant,manager,'Branch Manager',manager.branchId,staff.allowedModules));
  denied(()=>enforceAssignment(tenant,manager,'Tenant Owner',manager.branchId,staff.allowedModules));
  denied(()=>enforceAssignment(tenant,manager,'Viewer',manager.branchId,['banking']));
  denied(()=>enforceAssignment(tenant,{...manager,allowedModules:[]},'Mobile Money Operator',manager.branchId,['mobile_money']));
});
test('Tenant Owner can assign cross-branch roles; ordinary staff cannot use administrator operations',()=>{
  assert.deepEqual(staffFilter(owner),{role:{$ne:'Tenant Owner'}});
  assert.deepEqual(directoryFilter(owner),{});
  assert.doesNotThrow(()=>enforceAssignment(tenant,owner,'Reconciliation Officer',otherBranch,['mobile_money']));
  denied(()=>enforceAssignment(tenant,owner,'Tenant Owner',otherBranch,[]));
  denied(()=>staffFilter({...manager,role:'Viewer'}));
  denied(()=>staffFilter({...manager,branchId:null}));
});
test('Branch Manager navigation and staff form are limited without changing dashboard CSS',async()=>{
  const menu=tenantMenu(tenant,manager);
  assert(menu.some(g=>g.items.some(i=>i.href==='/tenant/users')));
  assert(!menu.some(g=>g.items.some(i=>i.href==='/tenant/billing')));
  const data={users:[],invitations:[],roles:managedRoles(manager),branches:[{_id:manager.branchId,name:'Branch One',code:'b1'}],assignable:['mobile_money'],plan:plans[1]};
  const html=await ejs.renderFile(path.join(__dirname,'../src/views/layouts/dashboard.ejs'),{
    context:'tenant',pageTitle:'Staff',pageSub:'Branch staff',currentPath:'/tenant/users',tenant,user:manager,menu,view:'../tenant/users/index',data,
    flash:null,assetVersion:'test',csrfToken:'safe',money:()=>'',amountFromMinor:()=>''
  });
  assert.match(html,/Assigned-branch controls/);assert.match(html,/Your branch only/);
  assert.match(html,/Mobile Money Operator/);assert.match(html,/Viewer/);
  assert.doesNotMatch(html,/<option value="Reconciliation Officer"/);
});
test('catalogue is read-only and contains no in-memory financial records',()=>{
  assert(Object.isFrozen(plans));assert(Object.isFrozen(modules));
  assert(!('tenants' in require('../src/data/store')));
  assert(!('tenantState' in require('../src/data/store')));
  assert(!('addTenantTransaction' in require('../src/data/store')));
  assert.throws(()=>{plans[1].limits.users=9999;},TypeError);
});
