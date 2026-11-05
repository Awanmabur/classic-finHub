'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const crypto=require('node:crypto');const mongoose=require('mongoose');
const path=require('node:path');const ejs=require('ejs');
const {entitledTenant}=require('./helpers/entitlement');
const {permissionsFor,INVITABLE,BRANCH_INVITABLE,requiresTenantMfa}=require('../src/config/roles');
const {hasModuleForUser,assignableModules}=require('../src/tenant/services/moduleAccess.service');
const {tenantMenu}=require('../src/services/menu.service');
const {sourcesFor}=require('../src/tenant/services/operationsReports.service');
const subs=require('../src/platform/services/moduleSubscriptions.service');
const approval=require('../src/tenant/services/approvals.service');
const branch='507f1f77bcf86cd799439011';const maker='507f1f77bcf86cd799439012';const reviewer='507f1f77bcf86cd799439013';
const grant=(moduleKey)=>({moduleKey,status:'granted',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2028-01-01'),currency:'USD',limits:{users:8,branches:3,recordsPerMonth:0}});
const tenant=(keys)=>entitledTenant({plan:'modular',enabledModules:[],moduleGrants:keys.map(grant)});
const actor=(role,modules=['approval_workflows'],id=maker,branchId=branch)=>({id,role,branchId,allowedModules:modules,permissions:permissionsFor(role)});
const example={code:'purchase_review',name:'Purchase Review',category:'procurement',steps:['Approval Officer','Tenant Owner'],expiresHours:72};
const request={policyCode:'purchase_review',subject:'Purchase new equipment',justification:'Replacement equipment for the branch team',idempotencyKey:crypto.randomUUID()};
function rejected(fn,status){assert.throws(fn,e=>e.status===status);}
test('Approval Workflows is independently subscribable with dedicated roles, and financial reviews remain separate',()=>{
 const t=tenant(['approval_workflows']);const a=actor('Approval Requester');
 assert(subs.eligible('approval_workflows'));assert(hasModuleForUser(t,a,'approval_workflows'));
 assert(!hasModuleForUser(t,a,'mobile_money'));assert(!hasModuleForUser(t,a,'reports'));
 assert(tenantMenu(t,a).some(g=>g.items.some(i=>i.href==='/tenant/approvals')));
 assert(!tenantMenu(t,a).some(g=>g.items.some(i=>i.href==='/tenant/forex')));
 assert(assignableModules(t,'Approval Requester').includes('approval_workflows'));
 assert(INVITABLE.includes('Approval Officer'));assert(BRANCH_INVITABLE.includes('Approval Requester'));
 assert(requiresTenantMfa('Approval Officer'));
 assert(!a.permissions.includes('mobile_money.review'));
 assert(!actor('Approval Officer').permissions.includes('forex.quotes.review'));
 assert.equal(subs.validateGrant({moduleKey:'approval_workflows',days:30,users:3,branches:1,recordsPerMonth:0,
  reason:'Standalone approval module requested by tenant administrator'}).moduleKey,'approval_workflows');
});
test('Policy validation enforces immutable 1–3 step configuration, roles, deadlines and categories',()=>{
 assert.deepEqual(approval.policyInput(example).steps,[{role:'Approval Officer'},{role:'Tenant Owner'}]);
 for(const input of [{...example,code:'../owner'},{...example,steps:[]},{...example,steps:['Auditor']},
  {...example,steps:['Tenant Owner','Branch Manager','Approval Officer','Reconciliation Officer']},
  {...example,expiresHours:0},{...example,expiresHours:721},{...example,category:'payment_execution'}])
  rejected(()=>approval.policyInput(input),400);
 const schema=require('../src/tenant/schemas/ApprovalPolicy.schema');
 assert(schema.path('steps').options.immutable);assert(schema.path('version').options.immutable);
 assert(schema.indexes().some(([key,opt])=>key.code===1&&key.version===1&&opt.unique));
});
test('Request validation requires an opaque UUID, bounded descriptions, and a server-derived branch',()=>{
 assert.equal(approval.requestInput(request).subject,request.subject);
 rejected(()=>approval.requestInput({...request,idempotencyKey:'123'}),400);
 rejected(()=>approval.requestInput({...request,subject:'X'}),400);
 rejected(()=>approval.requestInput({...request,justification:'tiny'}),400);
 rejected(()=>approval.validBranch(actor('Approval Requester'),'507f1f77bcf86cd799439015'),403);
 assert.equal(approval.validBranch(actor('Approval Requester'),undefined),branch);
 assert.equal(approval.validBranch(actor('Tenant Owner'),branch),branch);
 assert.equal(approval.validBranch(actor('Tenant Owner'),''),branch,'owner uses their account assignment');
 rejected(()=>approval.scope(actor('Approval Officer',['approval_workflows'],reviewer,null)),403);
});
test('Self-approval and repeated reviewer decisions are forbidden; exact role, branch and expiry matter',()=>{
 const base={requesterId:maker,branchId:branch,status:'pending',steps:['Approval Officer','Tenant Owner'],currentStep:0,
  expiresAt:new Date('2030-01-01'),decisions:[]};
 const officer=actor('Approval Officer',['approval_workflows'],reviewer);
 assert(approval.canDecide(officer,base));
 assert(!approval.canDecide(actor('Approval Officer'),base));
 assert(!approval.canDecide(actor('Branch Manager',['approval_workflows'],reviewer),base));
 assert(!approval.canDecide(actor('Approval Officer',['approval_workflows'],reviewer,'507f1f77bcf86cd799439017'),base));
 assert(!approval.canDecide(officer,{...base,expiresAt:new Date('2020-01-01')}));
 assert(!approval.canDecide(officer,{...base,decisions:[{actorId:reviewer}]}));
 assert(!approval.canDecide(officer,{...base,status:'approved'}));
 assert(approval.canDecide(actor('Tenant Owner',['approval_workflows'],reviewer),{...base,currentStep:1,
  decisions:[{actorId:'507f1f77bcf86cd799439014'}]}));
});
test('Request snapshots and indexes preserve original policy/routing and idempotency',()=>{
 const schema=require('../src/tenant/schemas/ApprovalRequest.schema');
 for(const field of ['requesterId','branchId','subject','justification','steps','policyCode','policyVersion','expiresAt'])
  assert(schema.path(field).options.immutable,field);
 assert(schema.indexes().some(([key,opt])=>key.idempotencyKey===1&&opt.unique));
 assert(schema.indexes().some(([key,opt])=>key.reference===1&&opt.unique));
});
test('Approval history and dashboard escape text and suppress unauthorized decision controls',async()=>{
 const r={_id:branch,reference:'APR-100',subject:'<img src=x onerror=alert(1)>',policyName:'Purchase',policyVersion:2,
  policyCode:'purchase_review',category:'general',justification:'<script>alert(1)</script>',status:'pending',
  requesterId:maker,branchId:branch,currentStep:0,steps:['Approval Officer'],decisions:[],expiresAt:new Date('2030-01-01'),createdAt:new Date('2026-11-01')};
 const rendered=await ejs.renderFile(path.join(__dirname,'../src/views/tenant/approvals/index.ejs'),{
  csrfToken:'csrf',user:actor('Tenant Owner'),data:{policies:[],records:{items:[r],nextCursor:null},reviewQueue:[],branches:[],
   canManage:true,canSubmit:true,roles:approval.ROLES,categories:approval.CATEGORIES,status:'',idempotencyKey:crypto.randomUUID()}});
 assert.match(rendered,/name="_csrf" value="csrf"/);assert.match(rendered,/Publish version/);
 assert.match(rendered,/&lt;img src=x/);assert(!rendered.includes('<img src=x'));
 const noActions=await ejs.renderFile(path.join(__dirname,'../src/views/tenant/approvals/detail.ejs'),{
  csrfToken:'csrf',data:{request:r,canDecide:false,canCancel:false}});
 assert.match(noActions,/&lt;script&gt;/);assert(!noActions.includes('<script>alert(1)</script>'));
 assert.doesNotMatch(noActions,/Approve this step|Cancel and retain history/);
 const reviewerView=await ejs.renderFile(path.join(__dirname,'../src/views/tenant/approvals/detail.ejs'),{
  csrfToken:'csrf',data:{request:r,canDecide:true,canCancel:false}});
 assert.match(reviewerView,/Approve this step/);
});
test('Reports and Analytics treat Approval Workflows as optional separately authorized source',()=>{
 const {assignableModules}=require('../src/tenant/services/moduleAccess.service');
 assert(assignableModules(tenant(['approval_workflows']),'Reports Analyst').includes('approval_workflows'));
 assert(assignableModules(tenant(['approval_workflows']),'Analytics Analyst').includes('approval_workflows'));
 const auditor=actor('Auditor',['reports','approval_workflows']);
 assert(sourcesFor(tenant(['reports','approval_workflows']),auditor).some(s=>s.key==='approval_workflows'));
 assert(!sourcesFor(tenant(['reports']),auditor).some(s=>s.key==='approval_workflows'));
 assert(!sourcesFor(tenant(['approval_workflows']),auditor).length);
});
test('Approval expiry cannot enumerate tenants without an authenticated cursor',async()=>{
 const run=require('../src/jobs/approvalExpiry.job').run;
 await assert.rejects(run(),/cursor/);await assert.rejects(run({tenants:[],connectionForTenant:()=>({})}),/cursor/);
 await assert.rejects(approval.expireDue({},'date'),{status:400});
});
test('A real decision service appends only one stage and a same-transaction audit event',async()=>{
 const requestId='507f1f77bcf86cd799439021';
 const row={_id:requestId,reference:'APR-UNIT',branchId:branch,requesterId:maker,
  status:'pending',revision:0,currentStep:0,steps:['Approval Officer','Tenant Owner'],
  expiresAt:new Date('2030-01-01'),decisions:[]};
 const events=[],noop={createIndexes:async()=>{}};
 const model={...noop,
  findOne(filter){return {session:async()=>String(filter._id)===requestId?{...row,decisions:row.decisions.slice()}:null};},
  async findOneAndUpdate(filter,update,options){
   assert(options.session,'write requires database transaction');
   if(filter.revision!==row.revision||row.status!=='pending'||filter.currentStep!==row.currentStep)return null;
   Object.assign(row,update.$set);row.revision+=update.$inc.revision;
   row.currentStep+=update.$inc.currentStep;row.decisions.push(update.$push.decisions);
   return {...row,decisions:row.decisions.slice()};
  }
 };
 const audit={...noop,async create(items,options){assert(options.session);events.push(...items);}};
 const conn={models:{},startSession:async()=>({withTransaction:async fn=>fn(),endSession:async()=>{}})};
 for(const name of ['SecureTenantUser','SecureMobileTransaction','SecureAuditEvent','SecureStaffInvite','SecureBranch',
  'SecureCashSession','TransferContactV1','TransferOrderV1','BankReferenceV1','BankingRequestV1','ForexRateV1',
  'ForexQuoteV1','ApprovalPolicyV1','ApprovalRequestV1','NotificationMessageV1','NotificationTemplateV1','NotificationPreferenceV1','SmsInboxV1','LedgerAccountV2','LedgerJournalV2',
  'LedgerPostingV2','FinancialOperationV1','VerifiedFinancialEvidenceV1','FinancialExceptionV1'])conn.models[name]=noop;
 conn.models.ApprovalRequestV1=model;conn.models.SecureAuditEvent=audit;
 const t=tenant(['approval_workflows']),officer=actor('Approval Officer',['approval_workflows'],reviewer);
 const outcome=await approval.decide(conn,t,officer,requestId,{decision:'approve',note:'Checked this purchase against an approved budget'});
 assert.equal(outcome.currentStep,1);assert.equal(outcome.status,'pending');assert.equal(events.length,1);
 assert.equal(events[0].action,'approvals.request.step_approved');
 await assert.rejects(approval.decide(conn,t,officer,requestId,{decision:'approve',note:'Repeat would violate single-review requirement'}),e=>e.status===409);
 assert.equal(row.decisions.length,1);assert.equal(events.length,1);
});
