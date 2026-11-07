'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const path=require('node:path');
const ejs=require('ejs');
const mongoose=require('mongoose');
const bank=require('../src/tenant/services/banking.service');
const {permissionsFor,BRANCH_INVITABLE,requiresTenantMfa}=require('../src/config/roles');
const {hasModuleForUser,assignableModules}=require('../src/tenant/services/moduleAccess.service');
const {sourcesFor}=require('../src/tenant/services/operationsReports.service');
const {tenantMenu}=require('../src/services/menu.service');
const {entitledTenant}=require('./helpers/entitlement');
const oid=()=>String(new mongoose.Types.ObjectId());
const branch=oid(),operatorId=oid(),reviewerId=oid();const now=Date.now();
const grant=key=>({moduleKey:key,status:'granted',generation:1,periodStart:new Date(now-86400000),periodEnd:new Date(now+14*86400000),
 currency:'USD',priceMonthlyMinor:12900,limits:{users:6,branches:2,recordsPerMonth:key==='banking'?8:0}});
function tenant(){const t=entitledTenant({plan:'modular',enabledModules:[]});return {...t,status:'active',moduleGrants:[grant('banking'),grant('reports')]};}
function actor(role,mods=['banking']){return {id:operatorId,role,branchId:branch,permissions:permissionsFor(role),allowedModules:mods};}
const ref=()=>({customerName:'Customer Name',institutionName:'Sample Banking Institution',last4:'1234',currency:'UGX'});
const request=()=>({sourceId:oid(),kind:'withdrawal_request',amount:'15000',currency:'UGX',note:'Customer requested operation for scheduled branch verification',idempotencyKey:crypto.randomUUID()});
test('Banking independently subscribable, but direct deposit and withdrawal are disabled',()=>{
 const module=require('../src/data/store').modules.find(m=>m.key==='banking');
 assert.equal(module.runtimeStatus,'recording_only');
 assert(hasModuleForUser(tenant(),actor('Banking Operator'),'banking'));
 assert(!hasModuleForUser({...tenant(),moduleGrants:[grant('reports')]},actor('Banking Operator'),'banking'));
 assert.throws(()=>bank.deposit({amount:500}),{status:501});
 assert.throws(()=>bank.withdraw({amount:500}),{status:501});
 const schema=require('../src/tenant/schemas/BankingRequest.schema');
 assert.deepEqual(schema.path('status').enumValues,['requested','approved_pending_bank','posted_manual','rejected','cancelled','expired']);
 assert(schema.path('amountMinor').options.immutable);
 assert(!schema.path('status').enumValues.includes('settled'));
 assert(schema.indexes().some(([keys,options])=>keys.idempotencyKey===1&&options.unique));
});
test('Account references store last four only; full account numbers, HTML injection and wrong currency fail validation',()=>{
 assert.deepEqual(bank.validateReference(ref()),ref());
 for(const change of [{last4:'1234567890123456'},{last4:'12'},{last4:'<img'},{currency:'JPY'},{customerName:' '},{institutionName:'='},
  {customerName:['arrays forbidden']},{institutionName:'a'.repeat(121)}]){
  assert.throws(()=>bank.validateReference({...ref(),...change}),e=>e.status===400);
 }
 const schema=require('../src/tenant/schemas/BankReference.schema');assert(!schema.path('balance'));assert(!schema.path('accountNumber'));
});
test('Banking request validates operation, branch-independent exact amounts, distinct references, reason and UUID',()=>{
 const v=request();assert.equal(bank.validateRequest(v).amountMinor,15000);
 const transfer={...v,kind:'transfer_request',destinationId:oid()};
 assert.equal(bank.validateRequest(transfer).kind,'transfer_request');
 for(const change of [{kind:'settled'},{kind:'deposit'},{currency:'JPY'},{amount:'3.55'},{amount:'0'},{amount:'1000000000000'},
  {idempotencyKey:'invalid'},{sourceId:'not-id'},{note:'x'},{kind:'transfer_request',destinationId:v.sourceId},
  {kind:'withdrawal_request',destinationId:oid()},{validDays:0},{validDays:31}])assert.throws(()=>bank.validateRequest({...v,...change}),e=>e.status===400);
 assert.throws(()=>bank.validateRequest({...v,kind:'transfer_request'}),e=>e.status===400);
});
test('Banking role scope and branch assignment must not be supplied by client',()=>{
 assert(BRANCH_INVITABLE.includes('Banking Operator'));assert(!requiresTenantMfa('Banking Operator'));
 const operator=actor('Banking Operator');
 assert.throws(()=>bank.branchFor(operator,{branchId:oid()}),e=>e.status===403);
 assert.equal(bank.branchFor(operator,{}),branch);
 assert.deepEqual(bank.requestScope(operator),{branchId:branch,createdBy:operatorId});
 assert.deepEqual(bank.branchScope({...actor('Tenant Owner'),branchId:null}),{});
 assert.deepEqual(bank.branchScope({...actor('Auditor'),branchId:null}),{});
 assert.throws(()=>bank.requestScope({...operator,branchId:null}),e=>e.status===403);
 assert(!permissionsFor('Banking Operator').includes('banking.review'));
 assert(permissionsFor('Reconciliation Officer').includes('banking.review'));
 assert(!permissionsFor('Branch Manager').includes('banking.requests.create'));
 assert.throws(()=>bank.moduleAccess({...tenant(),moduleGrants:[grant('reports')]},operator,'banking.view'),e=>e.status===403);
});
test('Standalone Operations Reports remains independent and only includes entitled banking source',()=>{
 const t=tenant();
 assert.deepEqual(sourcesFor(t,actor('Reports Analyst',['reports'])).map(s=>s.key),['workspace']);
 assert(assignableModules(t,'Reports Analyst').includes('banking'));
 assert.deepEqual(sourcesFor(t,actor('Reports Analyst',['reports','banking'])).map(s=>s.key),['workspace','cash_shifts','banking']);
 assert(!permissionsFor('Reports Analyst').includes('banking.view'));
 assert.equal(sourcesFor({...t,moduleGrants:[grant('banking')]},actor('Reports Analyst',['banking','reports'])).length,0);
 assert(tenantMenu({...t,moduleGrants:[grant('banking')]},actor('Banking Operator')).some(g=>g.items.some(x=>x.href==='/tenant/banking/deposit')));
});
test('Immutable banking request snapshots, deduplication and no bank balance model',()=>{
 const schema=require('../src/tenant/schemas/BankingRequest.schema');
 assert(schema.path('source').schema.path('customerName').options.immutable);
 assert(schema.path('destination').schema.path('last4').options.immutable);
 assert(!schema.path('balance'));assert(!schema.path('bankBalance'));assert(!schema.path('isSettled'));
 const v=bank.validateRequest(request());const stored={createdBy:operatorId,branchId:branch,source:{referenceId:v.sourceId},
  kind:v.kind,destination:null,currency:v.currency,amountMinor:String(v.amountMinor),note:v.note,validDays:v.validDays};
 assert(bank.sameRequest(stored,actor('Banking Operator'),branch,v));
 assert(!bank.sameRequest(stored,actor('Banking Operator'),branch,{...v,amountMinor:70000}));
});
test('Banking UI renders protected instructions and links independently reviewed manual movements',async()=>{
 const data={records:{items:[],nextCursor:null},branches:[{_id:branch,name:'Main',currency:'UGX'}],queue:[],
  references:[{_id:oid(),customerName:'<script>alert(1)</script>',institutionName:'Bank A',last4:'1234'}],
  selectedBranchId:branch,canCreate:true,canReview:false,idempotencyKey:crypto.randomUUID(),formatMoneyMinor:(v,c)=>`${c} ${v}`};
 const page=path.join(__dirname,'../src/views/tenant/banking/index.ejs');
 const html=await ejs.renderFile(page,{data,user:actor('Banking Operator'),csrfToken:'csrf'});
 assert.match(html,/name="idempotencyKey"/);assert.match(html,/name="_csrf" value="csrf"/);
 assert.match(html,/Post banking operation/);
 assert.doesNotMatch(html,/<script>alert/);assert.match(html,/&lt;script&gt;/);
 assert.match(html,/action="\/tenant\/banking\/requests"/);
 assert.match(html,/External bank references remain instructions/);
 assert.doesNotMatch(html,/<form[^>]+action="\/tenant\/banking\/(?:deposit|withdraw|transfer)"/);
 const read=await ejs.renderFile(page,{data:{...data,canCreate:false,canReview:false},user:actor('Auditor'),csrfToken:'csrf'});
 assert.doesNotMatch(read,/Post banking operation/);
 const queue=[{_id:oid(),reference:'BK-TEST',kind:'deposit_request',currency:'UGX',amountMinor:'10000',source:{last4:'1234',institutionName:'Example'}}];
 const review=await ejs.renderFile(page,{data:{...data,canCreate:false,canReview:true,queue},user:actor('Reconciliation Officer'),csrfToken:'csrf'});
 assert.match(review,/Approve pending bank verification/);assert.doesNotMatch(review,/Post banking operation/);
});
test('Banking quota uses standalone counter and does not charge twice for idempotent replay',async()=>{
 const service=require('../src/platform/services/commercial.service');const t=tenant();t._id=oid();
 let last;const Model={findOneAndUpdate:async(filter,update,options)=>{last={filter,update,options};return {quantity:1};}};
 await service.reserveUsage(t,'banking_requests',{tx:true},new Date(),Model);
 assert.equal(last.filter.metric,'addon_banking_requests');assert.equal(last.filter.generation,1000000001);assert.equal(last.filter.quantity.$lt,8);
});
test('Aggregate banking report is scoped and excludes personal account details',async()=>{
 let pipeline;const conn={models:{BankingRequestV1:{aggregate:async p=>{pipeline=p;return [{_id:{currency:'UGX',kind:'deposit_request',status:'requested'},count:2,amount:{toString:()=> '50000'}}];}}}};
 const rows=await bank.reportRows({conn,filters:{},scope:{branchId:branch}});
 assert.equal(String(pipeline[0].$match.branchId),branch);assert.equal(rows[0].module,'Banking');assert.equal(rows[0].volume,'UGX 50,000');
 assert(!('customerName' in rows[0]));assert(!('last4' in rows[0]));assert(!('balance' in rows[0]));
});

test('Expired banking requests cannot be approved, and expiry job refuses missing tenant cursor',async()=>{
 const schema=require('../src/tenant/schemas/BankingRequest.schema');
 assert(schema.path('expiresAt').options.immutable);
 assert(schema.path('status').enumValues.includes('expired'));
 assert(schema.indexes().some(([keys])=>keys.status===1&&keys.expiresAt===1));
 const job=require('../src/jobs/bankingExpiry.job');
 await assert.rejects(job.run(),/tenant cursor/);
 await assert.rejects(job.run({tenants:[],connectionForTenant:()=>({})}),/tenant cursor/);
 await assert.rejects(bank.expireDue({},'not a date'),e=>e.status===400);
});
