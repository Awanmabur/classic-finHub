'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const view=require('../src/tenant/services/branchView.service');
const main={_id:'507f1f77bcf86cd799439011',name:'Kampala Main',code:'main',currency:'UGX'},east={_id:'507f1f77bcf86cd799439012',name:'East',code:'east',currency:'UGX'};
function connection(rows){return {models:{SecureBranch:{find:()=>({sort(){return this;},select(){return this;},lean:async()=>rows}),exists:async query=>rows.some(row=>String(row._id)===String(query._id)&&row.status!=='archived')}}};}
function req(role='Tenant Owner',method='GET',session={}){return {method,user:{id:'507f1f77bcf86cd799439013',role,branchId:main._id,transactionBranchId:main._id},session,tenantDb:connection([east,main]),originalUrl:'/tenant/reports/mobile?from=2026-11-01&network=MTN&cursor=stale'};}
test('tenant-wide viewing defaults to main, supports All, and leaves the operating assignment unchanged',async()=>{
 for(const role of ['Tenant Owner','Auditor']){
  const request=req(role),res={locals:{}};await view.context(request,res);
  assert.equal(request.user.viewBranchId,main._id);assert.equal(request.viewBranch.name,'Kampala Main');assert.equal(request.user.branchId,main._id);assert.equal(request.user.transactionBranchId,main._id);
  request.session.viewBranchId=east._id;await view.context(request,res);assert.equal(String(view.readScope(request.user).branchId),east._id);assert.equal(request.user.branchId,main._id);
  request.session.viewBranchId='all';await view.context(request,res);assert.deepEqual(view.readScope(request.user),{});assert.equal(request.viewBranch,null);
  request.method='POST';await view.context(request,res);assert.equal(request.user.viewBranchId,undefined,'view selection never enters a posting actor');assert.equal(request.session.viewBranchId,'all');
 }
 const firstVisit=req(),res={locals:{}};firstVisit.tenantDb=connection([]);
 await view.context(firstVisit,res);assert.equal(firstVisit.session.viewBranchId,undefined,'an empty workspace does not persist a synthetic All preference');
 firstVisit.tenantDb=connection([main]);await view.context(firstVisit,res);assert.equal(firstVisit.session.viewBranchId,main._id,'the first active main branch becomes the default after setup');
});
test('ordinary operators cannot activate a viewing branch through session state or the endpoint',async()=>{
 const request=req('Mobile Money Operator','GET',{viewBranchId:east._id}),res={locals:{}};request.user.viewBranchId=east._id;
 await view.context(request,res);assert.equal(request.user.viewBranchId,undefined);assert.equal(res.locals.canViewBranches,false);assert.deepEqual(view.readScope(request.user),{});
 let rejected;request.body={viewBranchId:east._id};await view.change(request,{redirect(){throw Error('forbidden branch change redirected');}},error=>{rejected=error;});assert.equal(rejected.status,403);
});
test('branch switch validates local active branches and preserves filters while removing stale page cursors',async()=>{
 const request=req();request.body={viewBranchId:east._id,returnTo:'/tenant/reports/mobile?from=2026-11-01&to=2026-11-07&network=MTN&cursor=old&page=2'};
 let redirected;await view.change(request,{redirect:(status,url)=>{redirected={status,url};}},error=>{throw error;});
 assert.equal(request.session.viewBranchId,east._id);assert.deepEqual(redirected,{status:303,url:'/tenant/reports/mobile?from=2026-11-01&to=2026-11-07&network=MTN'});
 request.body.viewBranchId='507f1f77bcf86cd799439099';let failure;await view.change(request,{},error=>{failure=error;});assert.equal(failure.status,404);assert.equal(request.session.viewBranchId,east._id);
 for(const unsafe of ['https://elsewhere.invalid/tenant/dashboard','//elsewhere.invalid/tenant/dashboard','/signin'])assert.equal(view.safeReturnTo(unsafe),'/tenant/dashboard');
});
test('a saved record follows its actual branch for navigation without altering transaction location',()=>{
 const request=req('Tenant Owner','POST',{viewBranchId:east._id,flash:{type:'good',message:'Saved.'}});request.operationBranch=main;
 view.followRecord(request,{branchId:main._id});assert.equal(request.session.viewBranchId,main._id);assert.equal(request.user.branchId,main._id);assert.match(request.session.flash.message,/Saved\. Viewing Kampala Main/);
 const operator=req('Mobile Money Operator','POST',{viewBranchId:east._id});view.followRecord(operator,{branchId:main._id});assert.equal(operator.session.viewBranchId,east._id);
});
