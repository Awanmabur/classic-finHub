'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createRequireAuth}=require('../src/middleware/requireAuth');
const {permissionsFor}=require('../src/config/roles');
const branchId='507f1f77bcf86cd799439011';const memberId='507f1f77bcf86cd799439012';
const identityId='507f1f77bcf86cd799439013';const tenantId='507f1f77bcf86cd799439014';
const tenant={slug:'unit-agent',_id:tenantId,status:'active',plan:'agent',enabledModules:['mobile_money']};
function scenario(account,activeBranch){
 let lookup=0;const model={findOne(){return{lean:async()=>account};}};
 const guard=createRequireAuth({getConnection:()=>({name:'test-tenant'}),getUserModel:()=>model,identityExists:async()=>true,
   getBranchModel:()=>({exists:async()=>{lookup++;return activeBranch;}})});
 const req={tenant,session:{tenantUserId:memberId,identityId,authVersion:2,authenticatedAt:Date.now(),mfaVerifiedAt:Date.now()},path:'/dashboard'};
 const res={statusCode:null,status(code){this.statusCode=code;return this;},send(message){this.message=message;return this;},redirect(code,url){this.statusCode=code;this.location=url;return this;}};
 return {guard,req,res,lookup:()=>lookup};
}
test('branch user is authenticated using tenant model and active branch without path resolution errors',async()=>{
 const account={_id:memberId,email:'branch@example.invalid',name:'Branch Manager',role:'Branch Manager',status:'active',authVersion:2,branchId,allowedModules:['mobile_money'],mfaEnabledAt:new Date()};
 const testCase=scenario(account,true);let nextErr,proceeded=false;
 await testCase.guard(testCase.req,testCase.res,e=>{nextErr=e;proceeded=!e;});
 assert.equal(nextErr,undefined);assert.equal(proceeded,true);
 assert.equal(testCase.lookup(),1);
 assert.equal(testCase.req.user.branchId,branchId);
 assert.deepEqual(testCase.req.user.permissions,permissionsFor('Branch Manager'));
});
test('branch users cannot access dashboard with missing or archived branch',async()=>{
 const account={_id:memberId,email:'operator@example.invalid',role:'Mobile Money Operator',status:'active',authVersion:2,allowedModules:['mobile_money'],branchId};
 const archived=scenario(account,false);let proceeded=false;
 await archived.guard(archived.req,archived.res,()=>proceeded=true);
 assert.equal(proceeded,false);assert.equal(archived.res.statusCode,403);
 const noBranch=scenario({...account,branchId:null},true);
 await noBranch.guard(noBranch.req,noBranch.res,()=>proceeded=true);
 assert.equal(noBranch.res.statusCode,403);assert.equal(noBranch.lookup(),0);
});
test('legacy users receive no implicit newly activated modules',async()=>{
 const account={_id:memberId,email:'operator@example.invalid',role:'Mobile Money Operator',status:'active',authVersion:2,branchId};
 const testCase=scenario(account,true);let err;
 await testCase.guard(testCase.req,testCase.res,e=>err=e);
 assert.equal(err,undefined);assert.deepEqual(testCase.req.user.allowedModules,[]);
});
