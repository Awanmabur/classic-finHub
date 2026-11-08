'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const ejs=require('ejs');
const path=require('node:path');
const service=require('../src/tenant/services/notification.service');
const {permissionsFor,BRANCH_INVITABLE}=require('../src/config/roles');
const {entitledTenant}=require('./helpers/entitlement');
const {hasModuleForUser,assignableModules}=require('../src/tenant/services/moduleAccess.service');
const id=()=>String(new mongoose.Types.ObjectId());
const branch=id(),otherBranch=id(),ownerId=id(),managerId=id(),tellerId=id();
const tenant=entitledTenant({slug:'notification-test',plan:'enterprise',enabledModules:['notifications','reports','approval_workflows']});
const actor=(role,branchId=branch,userId=tellerId,allowedModules=['notifications'])=>({role,branchId,id:userId,name:'Staff',allowedModules,permissions:permissionsFor(role)});
function invalid(fn,status=400){assert.throws(fn,e=>e.status===status);}
test('Notifications is independently eligible, and operators have view-only permission',()=>{
 const module=require('../src/platform/services/moduleSubscriptions.service');
 assert(module.eligible('notifications'));assert.equal(require('../src/data/store').modules.find(x=>x.key==='notifications').runtimeStatus,'enabled');
 const user=actor('Mobile Money Operator');
 assert(hasModuleForUser(tenant,user,'notifications'));
 assert(user.permissions.includes('notifications.view'));assert(!user.permissions.includes('notifications.send'));
 assert(assignableModules(tenant,'Mobile Money Operator').includes('notifications'));
 const tenantNoNotifications=entitledTenant({slug:'no-notifications',enabledModules:['reports']});
 assert(!hasModuleForUser(tenantNoNotifications,user,'notifications'));
 assert(!service.canSend(tenant,user));assert(service.canSend(tenant,actor('Branch Manager',branch,managerId)));
});
test('Reserved template codes, unexpected variables and links are rejected',()=>{
 const base={code:'staff_news',name:'Staff News',subject:'Important update',body:'Hello {{recipient_name}} from {{tenant_name}}',emailAvailable:'on'};
 const v=service.templateInput(base);assert(v.emailAvailable);
 for(const change of [{code:'system_security'}, {body:'Hello {{unsupported}}'},
  {body:'Hello {{recipient_name'}, {subject:'https://attacker.invalid'}, {body:'<b>click</b> https://attacker.invalid'}]){
  invalid(()=>service.templateInput({...base,...change}));
 }
 assert.equal(service.renderText(v.body,{recipient_name:'A',tenant_name:'FinHub',sender_name:'Owner'}),'Hello A from FinHub');
});
test('Message validation rejects invalid recipient IDs and idempotency tokens',()=>{
 const base={recipientId:tellerId,templateCode:'staff_news',idempotencyKey:require('node:crypto').randomUUID()};
 assert.equal(service.messageInput(base).recipientId,tellerId);
 invalid(()=>service.messageInput({...base,recipientId:'other'}),404);
 invalid(()=>service.messageInput({...base,idempotencyKey:'fake'}));
 invalid(()=>service.messageInput({...base,templateCode:'../../escape'}));
});
test('Branch Managers cannot message cross-branch or privileged staff',()=>{
 const manager=actor('Branch Manager',branch,managerId);
 const ordinary={role:'Mobile Money Operator',status:'active',branchId:branch,allowedModules:['notifications']};
 assert(service.sendableRecipient(manager,ordinary,tenant));
 assert(!service.sendableRecipient(manager,{...ordinary,branchId:otherBranch},tenant));
 assert(!service.sendableRecipient(manager,{...ordinary,role:'Tenant Owner'},tenant));
 assert(!service.sendableRecipient(manager,{...ordinary,allowedModules:[]},tenant));
 assert(!service.sendableRecipient(manager,{...ordinary,status:'disabled'},tenant));
 assert(service.sendableRecipient(actor('Tenant Owner',null,ownerId),{...ordinary,branchId:otherBranch},tenant));
 assert(BRANCH_INVITABLE.includes('Mobile Money Operator'));
});
test('Inbox scope, mail state transitions, retry backoff and error classification are constrained',()=>{
 assert.deepEqual(service.scope(actor('Tenant Owner',null,ownerId)),{});
 assert.deepEqual(service.scope(actor('Branch Manager')), {branchId:branch});
 invalid(()=>service.scope(actor('Branch Manager',null)),403);
 assert.equal(service.classify({providerStatus:401}),'PERMANENT_PROVIDER_REJECTION');
 assert.equal(service.classify({providerStatus:429}),'TRANSIENT_PROVIDER_ERROR');
 assert.equal(service.classify({code:'MAIL_NOT_CONFIGURED'}),'MAIL_NOT_CONFIGURED');
 assert.equal(service.retryDelay(1),30000);assert(service.retryDelay(6)<=3600000);
 const filter=service.claimFilter(new Date());assert.equal(filter.$or.length,2);
});
test('Templates and inbox render safely with escaped user content; no unauthorized compose controls',async()=>{
 const file=path.join(__dirname,'../src/views/tenant/notifications/index.ejs');
 const base={inbox:{items:[{_id:tellerId,subject:'<svg onload=alert(1)>',emailState:'not_requested',createdAt:new Date(),readAt:null}],nextCursor:null},prefs:{emailOptIn:false},
 templates:[],recipients:[],logs:[],canManage:false,canSend:false,search:'',requestKey:require('node:crypto').randomUUID()};
 const html=await ejs.renderFile(file,{data:base,csrfToken:'csrf',user:actor('Mobile Money Operator')});
 assert.match(html,/&lt;svg/);assert(!html.includes('<svg onload'));assert(!html.includes('name="templateCode"'));
 const owner=await ejs.renderFile(file,{data:{...base,canManage:true,canSend:true,templates:[{code:'staff_news',name:'Staff',version:1,emailAvailable:false}],
  recipients:[{_id:tellerId,name:'Teller',role:'Mobile Money Operator'}]},csrfToken:'csrf',user:actor('Tenant Owner')});
 assert.match(owner,/Publish template version/);assert.match(owner,/name="_csrf" value="csrf"/);
 const detail=await ejs.renderFile(path.join(__dirname,'../src/views/tenant/notifications/detail.ejs'),
 {data:{message:{_id:id(),subject:'<img src=x>',body:'<script>evil</script>',readAt:null,createdAt:new Date(),templateCode:'staff_news',templateVersion:1,emailState:'pending'}},csrfToken:'csrf'});
 assert.match(detail,/&lt;script&gt;/);assert(!detail.includes('<script>evil</script>'));
});
test('Reports includes Notifications only for subscriptions and assigned reporting access',()=>{
 const {sourcesFor}=require('../src/tenant/services/operationsReports.service');
 const aud=actor('Auditor',branch,id(),['reports','notifications']);
 assert(sourcesFor(tenant,aud).some(s=>s.key==='notifications'));
 assert(!sourcesFor(entitledTenant({slug:'no-module',plan:'enterprise',enabledModules:['reports']}),aud).some(s=>s.key==='notifications'));
 assert(!sourcesFor(tenant,{...aud,allowedModules:['reports']}).some(s=>s.key==='notifications'));
 const analyst=actor('Analytics Analyst',branch,id(),['analytics','notifications']);
 assert(require('../src/tenant/services/analytics.service').sourcesFor(tenant,analyst).length===0,'analytics subscription required');
});
test('Worker job rejects arbitrary missing tenant sources and callbacks',async()=>{
 const job=require('../src/jobs/notification.job');
 await assert.rejects(job.run(),/Authenticated tenant cursor/);
 await assert.rejects(job.run({tenants:{async *[Symbol.asyncIterator](){yield {slug:'bad/../../'}}},connectionForTenant:()=>({}),mailer:async()=>({}),workerId:'notify-worker-1'}),/Invalid tenant/);
});
test('Delivery worker uses a fenced claim and records acceptance, not delivery',async()=>{
 const noticeId=new mongoose.Types.ObjectId();
 const row={_id:noticeId,emailState:'pending',availableAt:new Date(Date.now()-1000),attempts:0,
  recipientId:new mongoose.Types.ObjectId(tellerId),subject:'Message',body:'Plain text',leaseToken:null,leaseUntil:null};
 const recipient={_id:new mongoose.Types.ObjectId(tellerId),email:'recipient@example.invalid',role:'Mobile Money Operator',
  branchId:branch,allowedModules:['notifications'],status:'active'};
 const messages={
  async findOneAndUpdate(filter,update){
   if(row.emailState==='pending'||row.emailState==='retry'){
    Object.assign(row,update.$set);row.attempts+=update.$inc.attempts;
    return {...row};
   }
   return null;
  },
  async updateOne(filter,update){
   if(String(filter._id)===String(row._id)&&filter.leaseToken===row.leaseToken){Object.assign(row,update.$set);return {modifiedCount:1};}
   return {modifiedCount:0};
  }
 };
 const conn={models:{NotificationMessageV1:messages,SecureTenantUser:{findOne:()=>({select:()=>({lean:async()=>recipient})})},
   NotificationPreferenceV1:{findOne:()=>({lean:async()=>({emailOptIn:true})})}}};
 let sends=0;
 const first=await service.processOne(conn,tenant,'worker-a',async({to,idempotencyKey})=>{
  assert.equal(to,recipient.email);assert.equal(idempotencyKey,`cfh-notification-${noticeId}`);sends++;
  return {status:'accepted',messageId:'provider-accepted-1'};
 });
 assert.equal(first.state,'accepted');assert.equal(sends,1);assert.equal(row.emailState,'accepted');
 assert.equal((await service.processOne(conn,tenant,'worker-a',async()=>{throw Error('Duplicate send');})),null);
});
test('Worker suppresses email after recipient opt-out, and transient errors retry without fabricating success',async()=>{
 const row={_id:new mongoose.Types.ObjectId(),emailState:'pending',availableAt:new Date(0),attempts:0,
  recipientId:new mongoose.Types.ObjectId(tellerId),subject:'Note',body:'Note body'};
 const msg={async findOneAndUpdate(f,u){if(!['pending','retry'].includes(row.emailState))return null;
   Object.assign(row,u.$set);row.attempts+=u.$inc.attempts;return {...row};},
   async updateOne(f,u){if(row.leaseToken===f.leaseToken){Object.assign(row,u.$set);return {modifiedCount:1};}return {modifiedCount:0};}};
 const user={_id:new mongoose.Types.ObjectId(tellerId),email:'hidden@example.invalid',status:'active',
   role:'Mobile Money Operator',branchId:branch,allowedModules:['notifications']};
 let optedIn=false;
 const conn={models:{NotificationMessageV1:msg,SecureTenantUser:{findOne:()=>({select:()=>({lean:async()=>user})})},
  NotificationPreferenceV1:{findOne:()=>({lean:async()=>({emailOptIn:optedIn})})}}};
 assert.deepEqual(await service.processOne(conn,tenant,'worker-c',async()=>{throw Error('Forbidden send');}),{state:'suppressed'});
 assert.equal(row.emailState,'suppressed');
 Object.assign(row,{emailState:'pending',attempts:0,availableAt:new Date(0)});
 optedIn=true;
 assert.deepEqual(await service.processOne(conn,tenant,'worker-c',async()=>{throw Object.assign(Error('no service'),{providerStatus:503});}),
  {state:'retry',failureCode:'TRANSIENT_PROVIDER_ERROR'});
 assert.equal(row.emailState,'retry');assert.equal(row.attempts,1);
});
test('Sending creates exactly one tenant message with a same-transaction audit and duplicate guard',async()=>{
 const userId=new mongoose.Types.ObjectId(tellerId),actor=actorForOwner();
 const recipient={_id:userId,name:'Staff Member',email:'recipient@example.invalid',role:'Mobile Money Operator',
  status:'active',branchId:branch,allowedModules:['notifications']};
 const template={code:'staff_news',version:2,name:'Staff News',subject:'Notice for {{recipient_name}}',body:'From {{sender_name}} at {{tenant_name}}.',emailAvailable:true};
 let row=null;const audits=[];const noop={createIndexes:async()=>{}};
 const names=['SecureTenantUser','SecureMobileTransaction','SecureAuditEvent','SecureStaffInvite','SecureBranch','SecureCashSession',
 'TransferContactV1','TransferOrderV1','BankReferenceV1','BankingRequestV1','ForexRateV1','ForexQuoteV1',
 'ApprovalPolicyV1','ApprovalRequestV1','NotificationTemplateV1','NotificationMessageV1','NotificationPreferenceV1','SmsInboxV1','TransferSmsDeliveryV1',
 'LedgerAccountV2','LedgerJournalV2','LedgerPostingV2','FinancialOperationV1','VerifiedFinancialEvidenceV1','FinancialExceptionV1'];
 const models=Object.fromEntries(names.map(n=>[n,noop]));
 models.SecureTenantUser={...noop,findOne:()=>({session:()=>({lean:async()=>recipient})})};
 models.NotificationTemplateV1={...noop,findOne:()=>({session:()=>({lean:async()=>template})})};
 models.NotificationPreferenceV1={...noop,findOne:()=>({session:()=>({lean:async()=>({emailOptIn:true})})})};
 models.NotificationMessageV1={...noop,
  findOne:()=>({lean:async()=>row}),
  async create(items,{session}){assert(session);row={_id:new mongoose.Types.ObjectId(),...items[0]};return [row];}};
 models.SecureAuditEvent={...noop,async create(items,{session}){assert(session);audits.push(...items);}};
 const conn={models,startSession:async()=>({withTransaction:async callback=>callback(),endSession:async()=>{}})};
 const input={recipientId:tellerId,templateCode:'staff_news',idempotencyKey:require('node:crypto').randomUUID()};
 const result=await service.send(conn,tenant,actor,input);
 assert.equal(result.duplicate,false);assert.equal(result.message.emailState,'pending');
 assert.equal(result.message.subject,'Notice for Staff Member');
 assert.equal(result.message.body,`From ${actor.name} at ${tenant.name}.`);
 assert.equal(audits.length,1);assert.equal(audits[0].action,'notifications.message.created');
 const duplicate=await service.send(conn,tenant,actor,input);
 assert.equal(duplicate.duplicate,true);assert.equal(audits.length,1);
 await assert.rejects(service.send(conn,tenant,actor,{...input,templateCode:'other_template'}),e=>e.status===409);
 function actorForOwner(){return {id:ownerId,role:'Tenant Owner',name:'Owner',permissions:['*'],allowedModules:['notifications']};}
});
