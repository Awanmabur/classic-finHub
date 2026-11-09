'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {requestContext}=require('../src/tenant/services/transactionBranch.service');
const first={_id:'507f1f77bcf86cd799439011',name:'Main',code:'main',currency:'USD',currencies:['USD'],status:'active'};
const second={...first,_id:'507f1f77bcf86cd799439012',name:'Other',code:'other'};
const actor={id:'507f1f77bcf86cd799439013',role:'Tenant Owner',branchId:first._id};
async function context(req){const res={locals:{}};await new Promise((resolve,reject)=>requestContext(req,res,error=>error?reject(error):resolve()));return res;}
test('one fresh branch read serves owner operating and viewing context without crossing transaction location',async()=>{
 let reads=0,branches=[first,second];
 const Branch={find(){reads++;return{sort(){return this;},lean:async()=>branches};},findOne(){assert.fail('operating context must reuse this request snapshot');}};
 const conn={models:{SecureBranch:Branch}},session={viewBranchId:second._id};
 const request=()=>({tenantDb:conn,user:{...actor},session,method:'GET',originalUrl:'/tenant/dashboard'});
 const req=request(),res=await context(req);
 assert.equal(reads,1);assert.equal(String(req.operationBranch._id),first._id);assert.equal(req.user.viewBranchId,second._id);assert.equal(res.locals.viewBranches.length,2);
 branches=[second];const next=request();await context(next);
 assert.equal(reads,2,'each request must re-read branch state');assert.equal(next.operationBranch,null);assert.match(next.operationBranchError,/inactive or unavailable/);
});
test('staff context reuses only the active branch freshly authenticated on the same request',async()=>{
 const conn={models:{SecureBranch:{find(){assert.fail('staff must not enumerate other branches');},findOne(){assert.fail('branch was already authenticated for this request');}}}};
 const req={tenantDb:conn,user:{...actor,role:'Mobile Money Operator'},authenticatedBranch:first,session:{},method:'GET',originalUrl:'/tenant/mobile-money'};
 const res=await context(req);assert.equal(req.operationBranch,first);assert.equal(res.locals.canViewBranches,false);assert.equal(req.user.viewBranchId,undefined);
});
