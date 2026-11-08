'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),ejs=require('ejs'),path=require('node:path');
const service=require('../src/tenant/services/fundedOperations.service');
const ids=Array.from({length:8},()=>crypto.randomBytes(12).toString('hex'));
const opened={_id:ids[1],name:'Reviewed shared settlement',kind:'wallet',currency:'USD',status:'active',operatorId:null,
 openingBalanceMinor:'0',openingApprovedAt:new Date(),reconciliationState:'matched',bookBalanceMinor:'10000'};

test('manual posting only accepts independently opened and reconciled balances for the operating staff member',()=>{
 const options={kind:'wallet',currency:'USD',actorId:ids[0]};
 assert.equal(service.choose([opened],opened._id,options),opened._id);
 assert.equal(service.choose([{...opened,operatorId:ids[0]}],opened._id,options),opened._id);
 for(const change of [{openingBalanceMinor:null},{openingApprovedAt:null},{reconciliationState:'mismatch'},
  {reconciliationState:'stale'},{status:'held'},{operatorId:ids[2]}]){
  assert.throws(()=>service.choose([{...opened,...change}],opened._id,options),{status:409});
 }
 const pendingDefault={...opened,_id:ids[3],selectionKey:'pending-default',openingApprovedAt:null};
 assert.equal(service.choose([pendingDefault,opened],null,options),opened._id,'an unusable default must not hide a usable balance');
});

test('manual movement form excludes unreconciled balances and other operators wallets for tenant owners',async()=>{
 const own={...opened,_id:ids[2],name:'Own reviewed wallet',operatorId:ids[0]};
 const other={...opened,_id:ids[3],name:'Other operator wallet',operatorId:ids[7]};
 const pending={...opened,_id:ids[4],name:'Opening still pending',openingApprovedAt:null};
 const held={...opened,_id:ids[5],name:'Unresolved balance difference',reconciliationState:'mismatch'};
 const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/tenant/funded/prepare.ejs'),{
  csrfToken:'test-csrf',data:{type:'banking',snapshot:{kind:'deposit_request',paymentChannel:'Mobile money',currency:'USD',amountMinor:'100'},
   source:{_id:ids[6],reference:'BANK-READINESS'},actor:{id:ids[0],role:'Tenant Owner'},accounts:[opened,own,other,pending,held],idempotencyKey:crypto.randomUUID()}
 });
 assert.match(html,new RegExp(`value="${opened._id}"`));
 assert.match(html,new RegExp(`value="${own._id}"`));
 for(const account of [other,pending,held])assert.doesNotMatch(html,new RegExp(`value="${account._id}"`));
});
