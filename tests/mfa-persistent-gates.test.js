'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Tenant=require('../src/platform/models/Tenant');
const treasury=require('../src/tenant/treasury/service');
const backups=require('../src/tenant/backups/service');
const workspace=require('../src/tenant/workspace/service');
const operations=require('../src/tenant/workspace/operations');
const {entitledTenant}=require('./helpers/entitlement');
const {tenantDbNameFromSlug}=require('../src/config/tenantDatabaseName');
const {permissionsFor}=require('../src/config/roles');
const id=n=>n.toString(16).padStart(24,'0');
function policy(t){const previous=process.env.MFA_ENABLED;t.after(()=>{if(previous===undefined)delete process.env.MFA_ENABLED;else process.env.MFA_ENABLED=previous;});}
function query(value){return{session(){return this;},select(){return this;},lean:async()=>value};}
function fixture(t){
 const tenant=entitledTenant({_id:id(1),slug:'mfa-gate-test',plan:'enterprise',enabledModules:['money_transfer'],setupStatus:'complete'});
 tenant.dbName=tenantDbNameFromSlug(tenant.slug);
 let person={_id:id(2),name:'Policy test owner',email:'mfa-policy@example.invalid',role:'Tenant Owner',status:'active',authVersion:3,branchId:null,mfaEnabledAt:null};
 const lookups=[];
 const conn={name:tenant.dbName,models:{SecureTenantUser:{findOne(filter){lookups.push(filter);const role=filter.role?.$in||[person.role];return query(person.status==='active'&&role.includes(person.role)&&(!filter.mfaEnabledAt||person.mfaEnabledAt)?person:null);}}}};
 t.mock.method(Tenant,'findOne',()=>query(tenant));
 const actor={id:String(person._id),role:person.role,authVersion:person.authVersion,branchId:null,permissions:['*']};
 return{tenant,conn,actor,lookups,setPerson(value){person={...person,...value};}};
}
test('funds and workspace services honor disabled MFA while retaining persisted role authorization',async t=>{
 policy(t);const setup=fixture(t);
 process.env.MFA_ENABLED='false';
 assert.equal((await treasury.access(setup.conn,setup.tenant,setup.actor)).actor.role,'Tenant Owner');
 assert.equal((await workspace.access(setup.conn,setup.tenant,setup.actor,{manage:true})).actor.role,'Tenant Owner');
 process.env.MFA_ENABLED='true';
 await assert.rejects(treasury.access(setup.conn,setup.tenant,setup.actor),{status:403});
 await assert.rejects(workspace.access(setup.conn,setup.tenant,setup.actor,{manage:true}),{status:403});
 process.env.MFA_ENABLED='false';setup.setPerson({role:'Viewer'});
 await assert.rejects(treasury.access(setup.conn,setup.tenant,setup.actor),{status:403});
 await assert.rejects(workspace.access(setup.conn,setup.tenant,setup.actor,{manage:true}),{status:403});
});
test('backup authorization omits only the MFA predicate and restores it when reenabled',async t=>{
 policy(t);const setup=fixture(t);
 process.env.MFA_ENABLED='false';
 assert.equal((await backups.access(setup.conn,setup.tenant,setup.actor)).scopeKey,'tenant');
 assert.equal(setup.lookups.at(-1).status,'active');
 assert.deepEqual(setup.lookups.at(-1).role,{$in:['Tenant Owner','Branch Manager']});
 assert.equal(setup.lookups.at(-1).mfaEnabledAt,undefined);
 await assert.rejects(backups.access(setup.conn,setup.tenant,{...setup.actor,authVersion:2}),{status:403});
 await assert.rejects(backups.access({...setup.conn,name:'wrong_database'},setup.tenant,setup.actor),{status:403});
 setup.setPerson({role:'Money Transfer Operator'});
 await assert.rejects(backups.access(setup.conn,setup.tenant,setup.actor),{status:403});
 setup.setPerson({role:'Tenant Owner'});process.env.MFA_ENABLED='true';
 await assert.rejects(backups.access(setup.conn,setup.tenant,setup.actor),{status:403});
 assert.deepEqual(setup.lookups.at(-1).mfaEnabledAt,{$ne:null});
 setup.setPerson({mfaEnabledAt:new Date()});
 assert.equal((await backups.access(setup.conn,setup.tenant,setup.actor)).scopeKey,'tenant');
});
test('operational readiness follows MFA policy without manufacturing enrollment or independent reviewers',t=>{
 policy(t);const tenant=entitledTenant({plan:'enterprise',enabledModules:['money_transfer']});
 const owner={_id:id(2),role:'Tenant Owner',branchId:id(10),mfaEnabledAt:null};
 const operator={_id:id(3),role:'Money Transfer Operator',branchId:id(10),allowedModules:['money_transfer']};
 const reviewer={_id:id(4),role:'Reconciliation Officer',branchId:id(10),allowedModules:['money_transfer'],mfaEnabledAt:null};
 const actor={id:id(2),role:'Tenant Owner',permissions:permissionsFor('Tenant Owner'),viewBranchId:id(10)};
 const account=(n,kind,operatorId=null)=>({_id:id(n),branchId:id(10),kind,moduleKey:kind==='transfer_clearing'?'money_transfer':'shared',currency:'UGX',operatorId,status:'active',openingBalanceMinor:'1000',openingApprovedAt:new Date(),reconciliationState:'matched'});
 const input={tenant,actor,people:[owner,operator,reviewer],allBranches:[{_id:id(10),name:'Policy branch',currency:'UGX',currencies:['UGX']}],
  accounts:[account(20,'cash',operator._id),account(21,'transfer_clearing'),account(22,'bank')],
  shifts:[{branchId:id(10),operatorId:operator._id,currency:'UGX',status:'open',openingVerifiedAt:new Date(),treasuryAccountId:id(20)}]};
 process.env.MFA_ENABLED='true';assert.equal(operations.build(input).state,'blocked');
 process.env.MFA_ENABLED='false';const ready=operations.build(input);assert.equal(ready.state,'ready');assert.match(ready.checks.find(row=>row.id==='mfa').detail,/disabled/);
 assert.equal(owner.mfaEnabledAt,null);assert.equal(reviewer.mfaEnabledAt,null);
 const nobodyIndependent={...input,people:[operator],actor:{...actor,id:operator._id,role:operator.role,permissions:permissionsFor(operator.role),allowedModules:['money_transfer']}};
 assert.equal(operations.build(nobodyIndependent).state,'blocked');
 process.env.MFA_ENABLED='true';assert.equal(operations.build(input).state,'blocked');
});
