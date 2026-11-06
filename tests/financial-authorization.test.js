'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Types}=require('mongoose');
const Tenant=require('../src/platform/models/Tenant');
const models=require('../src/tenant/models');
const auth=require('../src/tenant/services/financialAuthorization.service');
const {entitledTenant}=require('./helpers/entitlement');
const {tenantDbNameFromSlug}=require('../src/config/tenantDatabaseName');
const operatorId=String(new Types.ObjectId()),branchId=String(new Types.ObjectId()),tenantId=String(new Types.ObjectId());
const actor={id:operatorId,role:'Mobile Money Operator',branchId,authVersion:3,permissions:['*'],allowedModules:['mobile_money']};
const tenant={...entitledTenant({plan:'agent',enabledModules:['mobile_money']}),_id:tenantId,slug:'financial-auth-test'};
const conn={name:tenantDbNameFromSlug(tenant.slug)},session={transaction:true};
const account={_id:operatorId,name:'Operator',role:actor.role,branchId,authVersion:3,allowedModules:['mobile_money']};
function query(value){return {lean:async()=>value,session(){return this;},sort(){return this;},limit(){return this;}};}
async function withModels({storedTenant=tenant,storedAccount=account,branch={_id:branchId,status:'active'}}={},run){
 const originalTenant=Tenant.findOneAndUpdate,originalUser=models.tenantUserModel,originalBranch=models.branchModel;
 const calls=[];
 Tenant.findOneAndUpdate=(filter,write,options)=>{calls.push({model:'tenant',filter,write,options});return query(storedTenant);};
 models.tenantUserModel=()=>({findOneAndUpdate:(filter,write,options)=>{calls.push({model:'user',filter,write,options});return query(storedAccount);}});
 models.branchModel=()=>({findOne:filter=>{calls.push({model:'branch',filter});return query(branch);},find:()=>query(branch?[branch]:[]),findOneAndUpdate:(filter,write,options)=>{calls.push({model:'branch-fence',filter,write,options});return query(branch);}});
 try{return await run(calls);}finally{Tenant.findOneAndUpdate=originalTenant;models.tenantUserModel=originalUser;models.branchModel=originalBranch;}
}
test('manual financial authorization fences persisted tenant and user with the financial transaction',async()=>{
 await withModels({},async calls=>{
  const result=await auth.authorizeMobileRecording(conn,session,actor,tenant,branchId,'cash_in');
  assert.equal(result.actor.id,operatorId);assert(!result.actor.permissions.includes('*'),'caller permission escalation is discarded');
  assert(result.actor.permissions.includes('mobile_money.cash_in'));assert.equal(result.tenant,tenant);
  for(const model of ['tenant','user']){const call=calls.find(row=>row.model===model);assert.equal(call.options.session,session);assert.equal(call.write.$inc.__v,1);}
  assert.equal(calls.find(row=>row.model==='user').filter.authVersion,3);
  assert.equal(calls.find(row=>row.model==='tenant').filter.dbName,conn.name);
 });
});
test('manual recording rejects inactive identities, changed workspaces and unassigned modules',async()=>{
 await withModels({storedTenant:null},()=>assert.rejects(auth.authorizeMobileRecording(conn,session,actor,tenant,branchId,'cash_in'),{status:403}));
 await withModels({storedAccount:null},()=>assert.rejects(auth.authorizeMobileRecording(conn,session,actor,tenant,branchId,'cash_in'),{status:403}));
 for(const storedAccount of [{...account,role:'Viewer'},{...account,allowedModules:[]},{...account,allowedModules:undefined}])
  await withModels({storedAccount},()=>assert.rejects(auth.authorizeMobileRecording(conn,session,actor,tenant,branchId,'cash_in'),{status:403}));
 await withModels({storedTenant:{...tenant,enabledModules:[]}},()=>assert.rejects(auth.authorizeMobileRecording(conn,session,actor,tenant,branchId,'cash_in'),{status:403}));
 await assert.rejects(auth.authorizeMobileRecording({name:'another_tenant'},session,actor,tenant,branchId,'cash_in'),{status:403});
});
test('fresh operating branch cannot redirect an entered operation into another drawer',async()=>{
 const other=String(new Types.ObjectId());
 await withModels({storedAccount:{...account,branchId:other},branch:{_id:other,status:'active'}},()=>assert.rejects(auth.authorizeMobileRecording(conn,session,actor,tenant,branchId,'cash_out'),{status:403}));
 await withModels({branch:null},()=>assert.rejects(auth.authorizeMobileRecording(conn,session,actor,tenant,branchId,'cash_in'),{status:403}));
 await assert.rejects(auth.authorizeMobileRecording(conn,session,actor,tenant,branchId,'transfer'),{status:400});
});

test('directory and reviewer actions use fixed capabilities and fence the active assigned branch',async()=>{
 const bankingTenant={...tenant,...entitledTenant({plan:'finance',enabledModules:['banking']}),_id:tenantId,slug:tenant.slug};
 const reviewer={...actor,role:'Reconciliation Officer'},storedAccount={...account,role:reviewer.role,allowedModules:['banking']};
 await withModels({storedTenant:bankingTenant,storedAccount},async calls=>{
  const result=await auth.fenceAction(conn,session,reviewer,bankingTenant,'banking','banking.review');
  assert.equal(result.actor.role,'Reconciliation Officer');
  const branch=calls.find(row=>row.model==='branch-fence');assert.equal(branch.filter._id,branchId);assert.equal(branch.options.session,session);assert.equal(branch.write.$inc.revision,1);
 });
 await withModels({storedTenant:bankingTenant,storedAccount:{...storedAccount,role:'Banking Operator'}},()=>assert.rejects(auth.fenceAction(conn,session,{...actor,role:'Banking Operator'},bankingTenant,'banking','banking.review'),{status:403}));
});
