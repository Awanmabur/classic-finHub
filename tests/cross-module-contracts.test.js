'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {modulesLost,combinedCapacity}=require('../src/platform/services/subscriptionTransition.policy');
const {branchMatch}=require('../src/tenant/reporting/aggregateScope');

test('base-plan downgrade preserves separately subscribed modules',()=>{
 const addOns=[{moduleKey:'mobile_money',limits:{users:15,branches:3}}];
 assert.deepEqual(modulesLost(['mobile_money','forex','reports'],['reports'],addOns),['forex']);
 assert.deepEqual(modulesLost(['mobile_money'],[],addOns),[]);
 assert.deepEqual(modulesLost(['forex','forex'],[],[]),['forex']);
});
test('combined capacity honors independent modules but not unrelated limits',()=>{
 assert.deepEqual(combinedCapacity({users:3,branches:1},[{limits:{users:15,branches:2}},{limits:{users:8,branches:5}}]),{users:15,branches:5});
 assert.deepEqual(combinedCapacity({users:6,branches:2}),{users:6,branches:2});
});
test('report branch scope converts ObjectId identifiers before aggregate match',()=>{
 const id='507f1f77bcf86cd799439011';
 class FakeObjectId{constructor(value){this.hex=value;}}
 const match=branchMatch({branchId:id},value=>new FakeObjectId(value));
 assert(match.branchId instanceof FakeObjectId);
 assert.equal(match.branchId.hex,id);
 assert.deepEqual(branchMatch({}),{});
 assert.deepEqual(branchMatch({branchId:id}),{branchId:id}); // string-backed notification messages
 assert.throws(()=>branchMatch({branchId:'other-branch'}),e=>e.status===403);
});
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function loadWithMocks(relativePath,mocks){
 const module={exports:{}};
 const source=fs.readFileSync(path.resolve(__dirname,relativePath),'utf8');
 vm.runInNewContext(source,{module,exports:module.exports,require(name){
  if(Object.hasOwn(mocks,name))return mocks[name];
  throw new Error('Unexpected dependency in isolated contract test: '+name);
 }},{filename:relativePath});
 return module.exports;
}
test('physical cash reports use an ObjectId for branch-restricted aggregation',async()=>{
 const branch='507f1f77bcf86cd799439011';
 class FakeObjectId{constructor(value){this.value=value;}}
 let pipeline;
 const service=loadWithMocks('../src/tenant/services/cashDrawer.service.js',{
  mongoose:{Types:{ObjectId:FakeObjectId,Decimal128:{fromString:x=>x}}},
  '../models':{cashSessionModel:()=>({aggregate:async stages=>{pipeline=stages;return []}})},
  './moduleAccess.service':{hasModuleForUser:()=>true},
  './mobileMoney.service':{dateBounds:()=>({$gte:new Date(0),$lt:new Date(86400000)}),formatMoneyMinor:String},
  '../reporting/aggregateScope':require('../src/tenant/reporting/aggregateScope')
 });
 await service.reportRows({conn:{},filters:{from:'2026-11-01',to:'2026-11-02'},scope:{branchId:branch}});
 assert(pipeline[0].$match.branchId instanceof FakeObjectId);
 assert.equal(pipeline[0].$match.branchId.value,branch);
 await service.reportRows({conn:{},filters:{},scope:{}});
 assert.equal(Object.hasOwn(pipeline[0].$match,'branchId'),false);
 await assert.rejects(service.reportRows({conn:{},filters:{},scope:{branchId:'injected'}}),e=>e.status===403);
});
test('cross-module reports never manufacture an additive total from overlapping sources',async()=>{
 const rows=[{module:'Workspace',activity:'audit',status:'recorded',currency:'—',count:3,volume:'—',fees:'—'}];
 const sources=[{key:'workspace',label:'Workspace',moduleKey:null,rows:async()=>rows},
  {key:'banking',label:'Banking',moduleKey:'banking',rows:async()=>[{...rows[0],module:'Banking',count:1}]}];
 const service=loadWithMocks('../src/tenant/services/operationsReports.service.js',{
  './mobileMoney.service':{dateBounds:()=>({$gte:new Date(0),$lt:new Date(86400000)}),csvCell:String},
  './moduleAccess.service':{hasPermission:()=>true,hasModuleForUser:()=>true,hasModule:()=>true},
  './branchView.service':{readScope:()=>({})},
  '../reporting/registry':sources
 });
 const owner={role:'Tenant Owner'};
 const combined=await service.generate({}, {}, owner,{source:'all'});
 assert.equal(combined.rows.length,2);
 assert.equal(combined.total,null);
 assert.match(combined.note,/must not be added/);
 const only=await service.generate({}, {}, owner,{source:'banking'});
 assert.equal(only.total,1);
});
