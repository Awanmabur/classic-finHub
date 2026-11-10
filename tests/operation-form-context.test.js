'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {entitledTenant}=require('./helpers/entitlement');
const forms=require('../src/tenant/services/operationForm.service'),pricing=require('../src/tenant/pricing/service');
const branch={_id:'507f1f77bcf86cd799439011',name:'Main',status:'active',currency:'UGX',currencies:['UGX','USD','SSP','KES']},destination={...branch,_id:'507f1f77bcf86cd799439012',name:'Receiving'};
const tenant=()=>entitledTenant({plan:'enterprise'}),owner={id:'507f1f77bcf86cd799439013',role:'Tenant Owner',permissions:['*'],branchId:branch._id};
test('transfer entry reads only active destinations and applicable safe prices, never history/review/report data',async t=>{
 let prices=0;t.mock.method(pricing,'context',async(_conn,_tenant,current)=>{prices++;assert.equal(current,branch);return [{_id:'rule',revision:1,operation:'money_transfer.send',currency:'UGX',fixedFeeMinor:'50',enabled:true,createdBy:'private-operator'},{operation:'banking.deposit',currency:'UGX'}];});
 const service=require('../src/tenant/services/moneyTransfer.service');for(const key of ['list','reviewQueue','reportRows'])t.mock.method(service,key,()=>assert.fail('Unused history/report must not delay entry'));
 const {spec,data}=await forms.context({},tenant(),owner,branch,'transfer',{currency:'USD'},{activeBranches:[branch,destination,{...destination,_id:'archived',status:'archived'}]});
 assert.equal(prices,1);assert.equal(spec.action,'/tenant/money-transfer/requests');assert.equal(data.selectedCurrency,'USD');assert.deepEqual(data.destinationBranches,[destination]);assert.equal(data.records,undefined);assert.equal(data.queue,undefined);
 assert.equal(data.pricingContext.length,1);assert.equal(data.pricingContext[0].fixedFeeMinor,'50');assert.equal(data.pricingContext[0].createdBy,undefined);assert.match(data.idempotencyKey,/^[a-f0-9-]{36}$/);
 const next=await forms.context({},tenant(),owner,branch,'transfer',{}, {activeBranches:[branch,destination]});assert.notEqual(next.data.idempotencyKey,data.idempotencyKey);
});
test('entry context preserves module/role/permission, active branch and currency checks before looking up prices',async t=>{
 t.mock.method(pricing,'context',()=>assert.fail('Unauthorized or invalid entries must not query prices'));
 for(const actor of [{...owner,role:'Auditor'},{...owner,permissions:[]}])await assert.rejects(forms.context({},tenant(),actor,branch,'transfer'),error=>error.status===403);
 await assert.rejects(forms.context({},tenant(),{...owner,role:'Money Transfer Operator',permissions:['money_transfer.create'],allowedModules:[]},branch,'transfer'),error=>error.status===403);
 await assert.rejects(forms.context({},tenant(),owner,null,'transfer'),error=>error.status===409);
 await assert.rejects(forms.context({},tenant(),owner,branch,'transfer',{currency:'EUR'}),error=>error.status===409&&/enabled operating currency/.test(error.message));
 await assert.rejects(forms.context({},tenant(),owner,branch,'not-an-operation'),error=>error.status===404);
 await assert.rejects(forms.context({},tenant(),owner,branch,'constructor'),error=>error.status===404);
});
test('banking entry requests only scoped choices and does not construct account history or review queues',async t=>{
 t.mock.method(pricing,'context',async()=>[]);const banking=require('../src/tenant/services/banking.service');
 const actor={...owner,role:'Banking Operator',allowedModules:['banking'],viewBranchId:destination._id};
 t.mock.method(banking,'listReferences',async(_conn,_tenant,actual,options)=>{assert.equal(actual.viewBranchId,undefined);assert.equal(options.branchId,branch._id);return [{_id:'account-choice'}];});
 for(const key of ['list','reviewQueue'])t.mock.method(banking,key,()=>assert.fail('Entry must not read history'));
 const {data}=await forms.context({},tenant(),actor,branch,'banking_withdrawal');assert.equal(data.workspaceOperation,'withdrawal_request');assert.deepEqual(data.references,[{_id:'account-choice'}]);assert.equal(data.records,undefined);
});
test('forex entry reads its own approved rate board without quotations or approval queues',async t=>{
 t.mock.method(pricing,'context',async()=>[]);const forex=require('../src/tenant/services/forex.service');
 const rate={_id:'rate',status:'active',branchId:branch._id,fromCurrency:'USD',toCurrency:'UGX'};
 t.mock.method(forex,'listRates',async(_conn,_tenant,actual,options)=>{assert.equal(actual.viewBranchId,undefined);assert.deepEqual(options,{status:'active',branchId:branch._id});return [rate];});
 for(const key of ['listQuotes','rateReviewQueue','quoteReviewQueue'])t.mock.method(forex,key,()=>assert.fail('Entry must not read histories or approval queues'));
 const {data}=await forms.context({},tenant(),{...owner,viewBranchId:destination._id},branch,'forex_buy');assert.equal(data.workspaceOperation,'buy');assert.deepEqual(data.rates,[rate]);
});
