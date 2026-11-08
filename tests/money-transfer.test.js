'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const path=require('node:path');
const ejs=require('ejs');
const mongoose=require('mongoose');
const service=require('../src/tenant/services/moneyTransfer.service');
const {permissionsFor,BRANCH_INVITABLE,requiresTenantMfa}=require('../src/config/roles');
const {hasModuleForUser,assignableModules}=require('../src/tenant/services/moduleAccess.service');
const {sourcesFor}=require('../src/tenant/services/operationsReports.service');
const {tenantMenu}=require('../src/services/menu.service');
const {entitledTenant}=require('./helpers/entitlement');
const id=()=>String(new mongoose.Types.ObjectId());
const branch=id(),destinationBranch=id(),operatorId=id(),reviewerId=id();
const now=Date.now();
const grant=key=>({moduleKey:key,status:'granted',generation:1,periodStart:new Date(now-86400000),periodEnd:new Date(now+86400000),
 currency:'USD',priceMonthlyMinor:8900,limits:{users:6,branches:2,recordsPerMonth:key==='money_transfer'?12:0}});
const tenant=()=>{const t=entitledTenant({plan:'modular',enabledModules:[]});return {...t,status:'active',moduleGrants:[grant('money_transfer'),grant('reports')]};};
const actor=(role,mods=['money_transfer'])=>({id:operatorId,role,branchId:branch,permissions:permissionsFor(role),allowedModules:mods});
const validContact={kind:'sender',fullName:'Test Customer',country:'UG',phone:'+256700123456'};
const validOrder=()=>({destinationBranchId:destinationBranch,senderId:id(),beneficiaryId:id(),currency:'UGX',amount:'10000',fee:'200',validDays:'7',idempotencyKey:crypto.randomUUID()});
const typedOrder=()=>({destinationBranchId:destinationBranch,senderName:'Ada Sender',senderPhone:'+256 700 123 456',senderCountry:'UG',receiverName:'Grace Receiver',receiverPhone:'+254712345678',receiverCountry:'KE',currency:'UGX',amount:'10000',fee:'200',validDays:'7',idempotencyKey:crypto.randomUUID()});
test('Money Transfer activates as independent internal module but does not enable payout endpoints',()=>{
 const item=require('../src/data/store').modules.find(m=>m.key==='money_transfer');
 assert.equal(item.runtimeStatus,'recording_only');
 const t=tenant(),o=actor('Money Transfer Operator');
 assert(hasModuleForUser(t,o,'money_transfer'));
 assert(!hasModuleForUser({...t,moduleGrants:[grant('reports')]},o,'money_transfer'));
 assert.throws(()=>service.sendMoney({amount:1}),{status:501});
 assert.throws(()=>service.payoutByPin({pin:'0000'}),{status:501});
 const schema=require('../src/tenant/schemas/TransferOrder.schema');
 assert.deepEqual(schema.path('status').enumValues,['requested','approved_pending_provider','collected_manual','paid_out_manual','rejected','cancelled','expired']);
 assert(!schema.path('status').enumValues.includes('settled'));
});
test('Transfer contact validation requires proper sender/beneficiary and international phone',()=>{
 assert.deepEqual(service.validateContact(validContact),validContact);
 for(const value of [{phone:'0700000000'},{kind:'agent'},{country:'UGANDA'},{phone:'+123'},{fullName:'x'},
  {phone:['+256700123456']},{phone:'=HYPERLINK(1,2)'}])
  assert.throws(()=>service.validateContact({...validContact,...value}),e=>e.status===400);
});
test('Transfer order validates exact currency minor units and bounded idempotency',()=>{
 const v=validOrder(),parsed=service.validateOrder(v);
 assert.equal(service.validateOrder({...v,destinationBranchId:destinationBranch.toUpperCase()}).destinationBranchId,destinationBranch);
 assert.equal(parsed.amountMinor,10000);assert.equal(parsed.feeMinor,200);assert.equal(parsed.validDays,7);
 for(const value of [{destinationBranchId:null},{destinationBranchId:''},{destinationBranchId:'invalid'},{currency:'JPY'},{currency:'UGX',amount:'1.25'},{amount:'0'},{fee:'20000'},
  {validDays:31},{validDays:0},{idempotencyKey:'test'},{senderId:'invalid'},{beneficiaryId:v.senderId}])
  assert.throws(()=>service.validateOrder({...v,...value}),e=>e.status===400);
 assert.throws(()=>service.validateOrder({...v,amount:'100000000000'}),e=>e.status===400);
});
test('Tellers type complete sender and receiver identities without saved contact identifiers',()=>{
 const input=typedOrder(),parsed=service.validateOrder(input);
 assert.equal(parsed.partyEntryMode,'typed');
 assert.deepEqual(parsed.sender,{contactId:null,name:'Ada Sender',phone:'+256700123456',country:'UG'});
 assert.deepEqual(parsed.beneficiary,{contactId:null,name:'Grace Receiver',phone:'+254712345678',country:'KE'});
 assert.equal(parsed.senderId,null);assert.equal(parsed.beneficiaryId,null);
 assert.equal(service.validateOrder({...input,senderPhone:'0700123456'}).sender.phone,'+256700123456');
 const legacy=service.validateOrder(validOrder());assert.equal(legacy.partyEntryMode,'saved_contact');
 for(const invalid of [{senderId:id()},{beneficiaryId:id()},{senderName:'A'},{receiverName:'<script>'},
  {senderName:'\nAda Sender'},{receiverName:'Grace\u0000 Receiver'},
  {receiverPhone:'+256123'},{senderPhone:'+256\n700123456'},{senderPhone:'+01234567890'},
  {senderCountry:'ZZ'},{receiverCountry:'Uganda'},{receiverPhone:['+254712345678']},{receiverName:undefined}])
  assert.throws(()=>service.validateOrder({...input,...invalid}),e=>e.status===400);
});
test('Typed request retries compare the complete immutable identity and capture, including entry mode',()=>{
 const parsed=service.validateOrder({...typedOrder(),senderDocument:'S-123',receiverDocument:'R-456'});
 const existing={...parsed,createdBy:operatorId,branchId:branch};
 const a=actor('Money Transfer Operator');assert(service.equivalent(existing,a,branch,parsed));
 for(const party of ['sender','beneficiary'])for(const field of ['name','phone','country'])
  assert(!service.equivalent(existing,a,branch,{...parsed,[party]:{...parsed[party],[field]:'changed'}}));
 assert(!service.equivalent(existing,a,branch,{...parsed,capture:{...parsed.capture,receiverDocument:'different'}}));
 assert(!service.equivalent({...existing,partyEntryMode:'saved_contact'},a,branch,parsed));
 const schema=require('../src/tenant/schemas/TransferOrder.schema');
 assert(schema.path('partyEntryMode').options.immutable);
 assert.equal(schema.path('sender').schema.path('contactId').options.default,null);
});
test('Role, branch and module restrictions cannot be bypassed by user-submitted fields',()=>{
 assert(BRANCH_INVITABLE.includes('Money Transfer Operator'));
 assert(!requiresTenantMfa('Money Transfer Operator'));
 assert(requiresTenantMfa('Reconciliation Officer'));
 const operator=actor('Money Transfer Operator');
 assert.throws(()=>service.selectedBranch(operator,{branchId:id()}),e=>e.status===403,'forged branch input is rejected');
 assert.equal(service.selectedBranch(operator,{}),branch,'branch comes from the account');
 assert.deepEqual(service.recordScope(operator),{branchId:branch,createdBy:operatorId});
 assert.deepEqual(service.recordScope(actor('Branch Manager')),{branchId:branch});
 assert.deepEqual(service.recordScope({...actor('Tenant Owner'),branchId:null}),{});
 assert.throws(()=>service.recordScope({...actor('Money Transfer Operator'),branchId:null}),e=>e.status===403);
 assert(!permissionsFor('Money Transfer Operator').includes('money_transfer.review'));
 assert(!permissionsFor('Branch Manager').includes('money_transfer.create'));
 assert(permissionsFor('Branch Manager').includes('money_transfer.review'));
});
test('Reports-only and Money Transfer-only tenants remain independent',()=>{
 const t=tenant();
 const analyst=actor('Reports Analyst',['reports']);
 assert.deepEqual(sourcesFor(t,analyst).map(s=>s.key),['workspace']);
 assert(assignableModules(t,'Reports Analyst').includes('money_transfer'));
 const both=actor('Reports Analyst',['reports','money_transfer']);
 assert.deepEqual(sourcesFor(t,both).map(s=>s.key),['workspace','cash_shifts','money_transfer']);
 assert(!permissionsFor('Reports Analyst').includes('money_transfer.create'));
 assert(!permissionsFor('Reports Analyst').includes('money_transfer.view'));
 const onlyMoney={...t,moduleGrants:[grant('money_transfer')]};
 assert(!sourcesFor(onlyMoney,both).length);
 assert(tenantMenu(onlyMoney,actor('Money Transfer Operator')).some(g=>g.items.some(i=>i.href==='/tenant/money-transfer/send')));
});
test('Contact edits cannot mutate immutable historical snapshots and indexes are unique',()=>{
 const schema=require('../src/tenant/schemas/TransferOrder.schema');
 assert(schema.path('sender').schema.path('name').options.immutable);
 assert(schema.path('beneficiary').schema.path('phone').options.immutable);
 assert(schema.indexes().some(([keys,options])=>keys.idempotencyKey===1&&options.unique));
 assert(schema.indexes().some(([keys,options])=>keys.reference===1&&options.unique));
 const existing={createdBy:operatorId,branchId:branch,sender:{contactId:id()},beneficiary:{contactId:id()},currency:'UGX',
 amountMinor:'10000',feeMinor:'100',validDays:7};
 const value={senderId:String(existing.sender.contactId),beneficiaryId:String(existing.beneficiary.contactId),currency:'UGX',
 amountMinor:10000,feeMinor:100,validDays:7};
 assert(service.equivalent(existing,actor('Money Transfer Operator'),branch,value));
 assert(!service.equivalent(existing,actor('Money Transfer Operator'),branch,{...value,amountMinor:11000}));
});
test('Transfer dashboard allows typed names with no saved contacts and escapes immutable record names',async()=>{
 const t=tenant(),user=actor('Money Transfer Operator'),fakeId=id(),contact={_id:fakeId,branchId:branch,fullName:'<script>alert(1)</script>',country:'UG',kind:'sender'};
 const data={records:{items:[{_id:fakeId,reference:'TR-SAFE',sender:{name:contact.fullName},beneficiary:{name:'Receiver'},status:'requested',amountMinor:'10000',currency:'UGX'}],nextCursor:null},queue:[],branches:[{_id:branch,name:'Main',currency:'UGX',status:'active'},{_id:destinationBranch,name:'Receiving office',currency:'UGX',status:'active'}],
  selectedBranchId:branch,contacts:[],countryOptions:require('../src/utils/selectionOptions').countryOptions(),
  canCreate:true,canReview:false,idempotencyKey:crypto.randomUUID(),formatMoneyMinor:(v,c)=>`${c} ${v}`};
 const page=path.join(__dirname,'../src/views/tenant/money-transfer/index.ejs');
 const html=await ejs.renderFile(page,{data,user,csrfToken:'token'});
 assert.match(html,/name="idempotencyKey"/);assert.match(html,/name="_csrf" value="token"/);
 assert.match(html,/Save transfer &amp; continue/);assert.doesNotMatch(html,/name="decision" value="approve"/);
 for(const name of ['senderName','senderPhone','senderCountry','receiverName','receiverPhone','receiverCountry'])assert.match(html,new RegExp('name="'+name+'"'));
 assert.doesNotMatch(html,/<select[^>]+name="fromBranchId"/);assert.match(html,/<input[^>]+value="Main"[^>]+readonly/);
 assert.match(html,new RegExp('<option value="'+destinationBranch+'"'));assert.doesNotMatch(html,new RegExp('<option value="'+branch+'"'));
 assert.match(html,/name="destinationBranchId"/);assert.match(html,/data-phone-prefix="\+211"/);assert.doesNotMatch(html,/<select[^>]+name="(?:senderCountry|receiverCountry)"/);
 assert.doesNotMatch(html,/name="(?:senderId|beneficiaryId)"|Select sender|Select beneficiary|before submitting a request|type="submit" disabled/);
 assert.doesNotMatch(html,/<script>alert/);assert.match(html,/&lt;script&gt;/);
 assert.match(html,/action="\/tenant\/money-transfer\/requests"/);
 assert.match(html,/Issued after reviewed collection/);
 assert.doesNotMatch(html,/<form[^>]+action="\/tenant\/money-transfer\/payout"/);
 const auditor=await ejs.renderFile(page,{data:{...data,canCreate:false,canReview:false},user:actor('Auditor'),csrfToken:'token'});
 assert.doesNotMatch(auditor,/Save transfer &amp; continue/);
 const reviewer=await ejs.renderFile(page,{data:{...data,canCreate:false,canReview:true,queue:[{
  _id:id(),reference:'TR-ABC',amountMinor:'1000',currency:'UGX',sender:{name:'Sender'},beneficiary:{name:'Recipient'},
  expiresAt:new Date(Date.now()+86400000)}]},user:actor('Reconciliation Officer'),csrfToken:'token'});
 assert.match(reviewer,/Approve pending provider/);assert.doesNotMatch(reviewer,/Save transfer &amp; continue/);
});
test('Transfer expiry job requires actual tenant cursor and never silently reports completion',async()=>{
 const job=require('../src/jobs/transferExpiry.job');
 await assert.rejects(job.run(),/tenant cursor/);
 await assert.rejects(job.run({tenants:[],connectionForTenant:()=>({})}),/tenant cursor/);
});
test('A valid standalone module subscription can grant workspace access when base plan expired',async()=>{
 const resolver=require('../src/middleware/tenantResolver');
 const Tenant=require('../src/platform/models/Tenant');
 const before=Tenant.findOne;
 const t=tenant();t.subscription={...t.subscription,periodEnd:new Date('2020-01-01')};
 let nexted=false,redirected=false;
 Tenant.findOne=()=>({lean:async()=>t});
 try{
  const req={session:{tenantId:id(),tenantUserId:id()},path:'/money-transfer',method:'GET'};
  const res={redirect:()=>{redirected=true;},status:()=>({send:()=>{}})};
  await resolver(req,res,()=>{nexted=true;});
  assert(nexted);assert(!redirected);
  assert.equal(req.tenant.slug,t.slug);
 }finally{Tenant.findOne=before;}
});
test('Standalone Money Transfer quotas use their own generation and monthly counter',async()=>{
 const commerce=require('../src/platform/services/commercial.service');
 const t=tenant();t._id=id();
 let last;
 const Model={findOneAndUpdate:async(filter,update,options)=>{last={filter,update,options};return {quantity:1};}};
 await commerce.reserveUsage(t,'money_transfer_requests',{session:true},new Date(),Model);
 assert.equal(last.filter.metric,'addon_money_transfer_requests');
 assert.equal(last.filter.quantity.$lt,12);
 assert.equal(last.filter.generation,1000000001);
 await assert.rejects(commerce.reserveUsage(t,'not_a_real_metric',{session:true}),{status:403});
});
test('Transfer report excludes individual identifiers and uses a branch-scoped database query',async()=>{
 let pipeline;
 const conn={models:{TransferOrderV1:{aggregate:async p=>{pipeline=p;return [{_id:{currency:'UGX',status:'requested'},count:2,
  amount:{toString:()=> '1000'},fees:{toString:()=> '10'}}];}}}};
 const result=await service.reportRows({conn,filters:{},scope:{branchId:branch}});
 assert.equal(pipeline[0].$match.branchId.toString(),branch);
 assert.deepEqual(result.map(r=>r.status),['requested']);
 assert.equal(result[0].volume,'UGX 1,000');
 assert(!('sender' in result[0]));assert(!('phone' in result[0]));
});
