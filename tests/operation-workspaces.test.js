'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const path=require('node:path');
const ejs=require('ejs');
const service=require('../src/tenant/services/operationWorkspace.service');
const forex=require('../src/tenant/services/forex.service');
const {permissionsFor}=require('../src/config/roles');
const {entitledTenant}=require('./helpers/entitlement');
const branch='507f1f77bcf86cd799439011',actorId='507f1f77bcf86cd799439012';
const tenant=entitledTenant({plan:'finance',enabledModules:['banking','forex']});
const actor=(role,modules=['banking','forex'])=>({id:actorId,role,branchId:branch,permissions:permissionsFor(role),allowedModules:modules});
test('Own-module workspaces remain usable without Reports and cannot read an unassigned module',async()=>{
 const op=actor('Banking Operator');
 assert.doesNotThrow(()=>service.authorize(tenant,op,'banking'));
 assert.throws(()=>service.authorize(tenant,op,'forex'),{status:403});
 assert.throws(()=>service.authorize(tenant,{...op,allowedModules:[]},'banking'),{status:403});
 await assert.rejects(service.report({},tenant,op,'money_transfer'),{status:403});
 assert.throws(()=>service.definition('__proto__'),{status:400});
});
test('Workspace filters reject query objects, unsupported states and invalid date ranges',()=>{
 const filters=service.filtersFor('forex',{from:'2026-11-01',to:'2026-11-05',kind:'buy',currency:'USD'});
 assert.equal(filters.kind,'buy');assert.equal(filters.dateBounds.$lt.toISOString(),'2026-11-06T00:00:00.000Z');
 for(const query of [{kind:'deposit_request'},{status:'settled'},{currency:'XXX'},{status:{$ne:''}},{from:'2026-02-30',to:'2026-03-01'},{from:'2026-01-01',to:'2026-11-01'}]){
  assert.throws(()=>service.filtersFor('forex',query),{status:400});
 }
});
test('Operator records and aggregates retain staff and branch scope, while auditors are tenant-wide',async()=>{
 const filters=service.filtersFor('banking',{from:'2026-11-01',to:'2026-11-05',kind:'deposit_request'});
 const scope=service.queryFor(actor('Banking Operator'),'banking',filters);
 assert.equal(String(scope.branchId),branch);assert.equal(String(scope.createdBy),actorId);assert.equal(scope.kind,'deposit_request');
 assert.deepEqual(service.scopeFor(actor('Auditor'),'banking'),{});
 assert.throws(()=>service.scopeFor({...actor('Banking Operator'),branchId:null},'banking'),{status:403});
 let pipeline;
 const conn={models:{BankingRequestV1:{aggregate:async value=>{pipeline=value;return [
  {_id:{day:'2026-11-05',currency:'UGX',status:'requested',kind:'deposit_request'},count:2,volume:'3000'},
  {_id:{day:'2026-11-05',currency:'KES',status:'requested',kind:'deposit_request'},count:1,volume:'12345'}
 ];}}}};
 const report=await service.report(conn,tenant,actor('Banking Operator'),'banking',{from:'2026-11-01',to:'2026-11-05'});
 assert.equal(String(pipeline[0].$match.createdBy),actorId);assert.equal(String(pipeline[0].$match.branchId),branch);
 assert.equal(report.rows[0].volume,'UGX 3,000');assert.equal(report.rows[1].volume,'KES 123.45');
 assert.equal(report.total,3);assert.equal(report.canExport,false);assert.equal(report.rows.length,2);
 assert(!('customerName' in report.rows[0]));
});
test('Forex direction is immutable validated input',()=>{
 const input={rateId:branch,customerLabel:'Client',amount:'100',validMinutes:15,note:'Customer requested a buy quotation',operation:'buy',idempotencyKey:crypto.randomUUID()};
 assert.equal(forex.quoteInput(input).operation,'buy');assert.equal(forex.quoteInput({...input,operation:undefined}).operation,'quote');
 assert.throws(()=>forex.quoteInput({...input,operation:'executed'}),{status:400});
 assert(require('../src/tenant/schemas/ForexQuote.schema').path('operation').options.immutable);
});
test('Operational report CSV protects spreadsheet cells and keeps FX source and target separate',()=>{
 const csv=service.csv({rows:[{day:'2026-11-05',kind:'=2+2',status:'quoted',currency:'UGX',count:1,volume:'UGX 20,000',fees:'',targetCurrency:'USD',target:'USD 5.50'}]});
 assert.match(csv,/'=2\+2/);assert.match(csv,/Target currency/);assert.match(csv,/USD 5.50/);assert.match(csv,/UGX 20,000/);
});
test('Module pages render complete approved submenu wording, records, exports and capability state',async()=>{
 for(const key of ['money_transfer','banking','forex']){
  const spec=service.definition(key),data={moduleKey:key,label:spec.label,basePath:`/tenant/${spec.path}`,title:'Module report',
   mode:key==='forex'?'cash':key==='money_transfer'?'payout':'records',total:1,filters:service.filtersFor(key),rows:[],
   records:{items:[{_id:branch,reference:'<img src=x>',createdAt:new Date(),party:'Client <script>',activity:'Internal request',volume:'UGX 10',fee:'UGX 0',target:'USD 0.01',status:'requested',href:`/tenant/${spec.path}/${branch}`}],nextCursor:null},canExport:true,note:'Internal workflow'};
  const html=await ejs.renderFile(path.resolve(__dirname,`../src/views/tenant/${spec.path}/workspace.ejs`),{data});
  assert.match(html,/Export CSV/);assert.doesNotMatch(html,/name="branchId"/);
  if(key==='money_transfer'){
   for(const label of ['Send money / Generate PIN','Payout by PIN','Pending payout queue','Money transfer record','Transfer fee summary','Transfer report summary'])assert(html.includes(label));
   assert.match(html,/Provider payout is not enabled/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<script>/);
  }
  if(key==='forex')assert.match(html,/No cash balance is inferred/);
 }
});
test('Specialized operational forms retain CSRF, idempotency and server-selected branch',async()=>{
 const base={branches:[{_id:branch,name:'Main',currency:'UGX',status:'active'}],selectedBranchId:branch,records:{items:[]},queue:[],
  idempotencyKey:crypto.randomUUID(),canCreate:true,canReview:false,formatMoneyMinor:service.formatAmount};
 const bank=await ejs.renderFile(path.resolve(__dirname,'../src/views/tenant/banking/index.ejs'),{user:actor('Banking Operator'),csrfToken:'test-csrf',data:{...base,references:[],workspaceTitle:'Deposit',workspaceOperation:'deposit_request'}});
 assert.match(bank,/name="kind" value="deposit_request"/);assert.doesNotMatch(bank,/name="destinationId"/);assert.match(bank,/name="_csrf" value="test-csrf"/);assert.doesNotMatch(bank,/name="branchId"/);
 const fx=await ejs.renderFile(path.resolve(__dirname,'../src/views/tenant/forex/index.ejs'),{user:actor('Forex Operator'),csrfToken:'csrf',data:{...base,rates:[],rateQueue:[],quoteQueue:[],canQuote:true,canPropose:true,canRateReview:false,canQuoteReview:false,amountLabel:service.formatAmount,workspaceTitle:'Buy forex from customer',workspaceOperation:'buy'}});
 assert.match(fx,/Forex Operations - Buy/);assert.match(fx,/name="operation" value="buy"/);assert.doesNotMatch(fx,/<form[^>]*action="\/tenant\/forex\/rates"/);
});
