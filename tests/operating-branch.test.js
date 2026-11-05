'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createOperatingBranch}=require('../src/middleware/operatingBranch');
const idA='aaaaaaaaaaaaaaaaaaaaaaaa',idB='bbbbbbbbbbbbbbbbbbbbbbbb',tenantA='cccccccccccccccccccccccc';
const records=[{_id:idA,status:'active',name:'Main',currency:'UGX'},{_id:idB,status:'active',name:'Annex',currency:'KES'}];
const Branch={
 findOne(query){return{select(){return{async lean(){return records.find(b=>String(b._id)===String(query._id)&&b.status===query.status)||null}}}}},
 find(query){return{select(){return{limit(n){return{async lean(){return records.filter(b=>b.status===query.status).slice(0,n)}}}}}}}
};
const middleware=createOperatingBranch({getBranchModel:()=>Branch});
function request(role='Mobile Money Operator',body={},session={}){
 return {
   tenant:{_id:tenantA},tenantDb:{},user:{id:'dddddddddddddddddddddddd',role,branchId:role==='Tenant Owner'?null:idA},
   session,method:'POST',path:'/mobile-money/cash-in',body
 };
}
async function run(req){
 let error,called=false;
 const res={statusCode:200,status(n){this.statusCode=n;return this},send(message){this.message=message;return this}};
 await middleware(req,res,e=>{called=true;error=e});
 if(error)throw error;
 return {res,called};
}
test('ordinary operator branch is automatic and immutable despite the browser',async()=>{
 const req=request();const outcome=await run(req);
 assert(outcome.called);assert.equal(req.operatingBranchId,idA);
 assert.equal(req.body.branchId,idA);
 const forged=request('Mobile Money Operator',{branchId:idB});
 const result=await run(forged);
 assert.equal(result.called,false);assert.equal(result.res.statusCode,403);
});
test('owner with multiple branches never gets a guessed default',async()=>{
 const owner=request('Tenant Owner');
 const result=await run(owner);
 assert.equal(result.called,false);assert.equal(result.res.statusCode,409);
 assert.equal(owner.operatingBranchId,null);
});
test('owner context is tenant-bound, recorded and enforced for all core financial writes',async()=>{
 for(const target of ['/mobile-money/cash-out','/mobile-money/shifts/open',
 '/money-transfer/contacts','/money-transfer/requests',
 '/banking/accounts','/banking/requests','/forex/rates','/forex/quotes']){
  const req=request('Tenant Owner',{}, {operatingBranchTenantId:tenantA,operatingBranchId:idB});
  req.path=target;
  const result=await run(req);
  assert(result.called,target);
  assert.equal(req.body.branchId,idB,target);
 }
 const forged=request('Tenant Owner',{branchId:idA},{operatingBranchTenantId:tenantA,operatingBranchId:idB});
 assert.equal((await run(forged)).res.statusCode,403);
 const otherTenant=request('Tenant Owner',{}, {operatingBranchTenantId:idA,operatingBranchId:idB});
 assert.equal((await run(otherTenant)).res.statusCode,409);
});
test('GET dashboard and administrative reads do not require branch context',async()=>{
 const req=request('Tenant Owner');req.method='GET';req.path='/dashboard';
 const result=await run(req);
 assert(result.called);assert.equal(req.operatingBranchId,null);
});
test('approved dashboard branch control is a read-only identity indicator',()=>{
 const approved=require('../src/tenant/services/approvedDashboard.service');
 const markup=approved.markup({name:'Teller',role:'Mobile Money Operator'},'Kampala Main');
 assert(markup.includes('<span id="branchSelect" role="status"'));
 assert(!markup.includes('<select id="branchSelect"></select>'));
 assert(markup.includes('Kampala Main'));
 const client=fs.readFileSync(path.join(__dirname,'../public/js/approved-dashboard.js'),'utf8');
 assert(!client.includes("branchSelect?.value"));
 assert(!client.includes("url.searchParams.set('branchId',branch)"));
});
