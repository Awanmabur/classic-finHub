'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const ejs=require('ejs');
const mongoose=require('mongoose');
const cash=require('../src/tenant/services/cashDrawer.service');
const schema=require('../src/tenant/models/CashSession');
const mobile=require('../src/tenant/services/mobileMoney.service');
const id=()=>String(new mongoose.Types.ObjectId());
const branchId=id(),operatorId=id(),otherBranch=id(),shiftId=id();
function operator(){return {id:operatorId,branchId,role:'Mobile Money Operator',allowedModules:['mobile_money']};}
test('cash shifts enforce active uniqueness, branch ownership, allowed state and immutable opening amount',async()=>{
 const indexes=schema.indexes();
 assert(indexes.some(([keys,opts])=>keys.activeKey===1&&opts.unique&&opts.partialFilterExpression));
 const Model=mongoose.model('CashShiftSchemaTest',schema);
 const obj=new Model({branchId,operatorId,currency:'UGX',openingMinor:mongoose.Types.Decimal128.fromString('10000')});
 assert.equal(obj.validateSync(),undefined);
 obj.status='settled';assert(obj.validateSync());obj.status='open';
 const invalid=new Model({branchId,operatorId,currency:'JPY',openingMinor:'1'});assert(invalid.validateSync());
 assert.equal(cash.key(branchId,operatorId),`${branchId}:${operatorId}`);
 assert.notEqual(cash.key(otherBranch,operatorId),cash.key(branchId,operatorId));
 assert.deepEqual(cash.visibleScope(operator()),{branchId:new mongoose.Types.ObjectId(branchId),operatorId:new mongoose.Types.ObjectId(operatorId)});
 assert.deepEqual(cash.visibleScope({id:operatorId,role:'Tenant Owner'}),{});
 assert.deepEqual(cash.visibleScope({id:operatorId,role:'Branch Manager',branchId}),{branchId:new mongoose.Types.ObjectId(branchId)});
});
test('cash operations reject unsupported roles before accessing an unrelated tenant database',async()=>{
 const tenant={};
 await assert.rejects(cash.open(null,tenant,{id:operatorId,role:'Viewer',allowedModules:[]},{openingCash:'10'}),{status:403});
 await assert.rejects(cash.decide(null,tenant,operator(),shiftId,{decision:'approve',note:'Not a supervisor'}),{status:403});
 await assert.rejects(cash.submit(null,tenant,{id:operatorId,role:'Auditor'},shiftId,{countedCash:'1'}),{status:403});
});
test('record attachment requires an open shift, correct operator and currency, with no overdraft',async()=>{
 const changes=[];const conn={models:{SecureCashSession:{findOneAndUpdate(q,u,o){changes.push([q,u,o]);return Promise.resolve({
  _id:shiftId,openingMinor:'20000',provisionalMovementMinor:String(u.$inc.provisionalMovementMinor)
 });}}}};
 const session={};
 assert.equal(String(await cash.attachRecord(conn,session,operator(),branchId,'UGX','cash_out',5000n)),shiftId);
 assert.equal(changes[0][0].status,'open');
 assert.equal(changes[0][0].activeKey,`${branchId}:${operatorId}`);
 assert.equal(String(changes[0][1].$inc.provisionalMovementMinor),'-5000');
 assert.equal(changes[0][2].session,session);
 await assert.rejects(cash.attachRecord(conn,session,operator(),branchId,'UGX','cash_out',30000n),{status:409});
 const missing={models:{SecureCashSession:{findOneAndUpdate:async()=>null}}};
 await assert.rejects(cash.attachRecord(missing,session,operator(),branchId,'UGX','cash_in',1n),{status:409});
});
test('submitted shifts fence review and correction writes; historical pre-shift entries remain accessible',async()=>{
 const tx={};
 const rejected={models:{SecureCashSession:{findOneAndUpdate:async()=>null}}};
 await assert.rejects(cash.fenceRecordChange(rejected,tx,{cashSessionId:shiftId}),{status:409});
 await cash.fenceRecordChange(rejected,tx,{cashSessionId:null});
});
test('cash shift reporting matches ObjectId branch, not caller text; values are aggregate-only',async()=>{
 let match;
 const conn={models:{SecureCashSession:{aggregate:async pipeline=>{match=pipeline[0].$match;return [
 {_id:{currency:'UGX',status:'approved'},count:1,expected:'120000'}];}}}};
 const rows=await cash.reportRows({conn,filters:{from:'2026-11-01',to:'2026-11-03'},scope:{branchId}});
 assert.equal(String(match.branchId),branchId);
 assert.match(rows[0].volume,/120,000/);
 assert.equal(rows[0].activity,'Physical cash shifts');
 assert.equal(rows[0].count,1);
 await assert.rejects(cash.reportRows({conn,filters:{},scope:{branchId:'not-an-objectid'}}),{status:403});
});
test('cash shift views have real server-backed actions and escape notes',async()=>{
 const item={_id:shiftId,branchId,operatorId,currency:'UGX',openingMinor:'10000',
  provisionalMovementMinor:'0',recordCount:0,status:'submitted',createdAt:new Date('2026-11-03T01:00:00Z'),
  submittedAt:new Date(),expectedClosingMinor:'10000',declaredClosingMinor:'9000',varianceMinor:'-1000',
  reviewNote:'<script>alert(1)</script>',closeHistory:[{at:new Date(),declaredMinor:'9000',expectedMinor:'10000',varianceMinor:'-1000',note:'Cash short during shift'}]};
 const base=path.join(__dirname,'../src/views/tenant/mobile-money');
 const rendered=await ejs.renderFile(path.join(base,'shifts.ejs'),{formatMoneyMinor:mobile.formatMoneyMinor,data:{shifts:{items:[item],nextCursor:'a-valid-token'},canOpen:true,
  canReview:true,branches:[{_id:branchId,currency:'UGX',name:'Main',status:'active'}]},user:{role:'Tenant Owner',branchId},csrfToken:'csrf'});
 assert.match(rendered,/shifts\/open/);assert.match(rendered,/Next page/);assert.match(rendered,/name="_csrf" value="csrf"/);
 const detail=await ejs.renderFile(path.join(base,'shift-detail.ejs'),{formatMoneyMinor:mobile.formatMoneyMinor,data:{shift:item,canSubmit:false,canReview:true},csrfToken:'csrf'});
 assert.match(detail,/name="decision" value="approve"/);assert.doesNotMatch(detail,/<script>/);assert.match(detail,/&lt;script&gt;/);
 const noActions=await ejs.renderFile(path.join(base,'shift-detail.ejs'),{formatMoneyMinor:mobile.formatMoneyMinor,data:{shift:item,canSubmit:false,canReview:false},csrfToken:'csrf'});
 assert.doesNotMatch(noActions,/name="decision"|name="countedCash"/);
 const ack=await ejs.renderFile(path.join(base,'acknowledgement.ejs'),{record:{_id:shiftId,createdAt:new Date(),operation:'cash_in',network:'MTN',networkReference:'REF-123',
  customer:'<script>alert(1)</script>',status:'pending_verification',reviewState:'accepted',correctionState:'none'},
  amount:'UGX 10000',fee:'UGX 0',reference:'CFH-ACK-TEST'});
 assert.match(ack,/NOT PROOF OF PAYMENT OR SETTLEMENT/);assert.doesNotMatch(ack,/<script>alert/);assert.match(ack,/&lt;script&gt;/);
});
test('independent opening approval and variance review enforce role and branch boundaries',async()=>{
 const {entitledTenant}=require('./helpers/entitlement');
 const tenant=entitledTenant({enabledModules:['mobile_money']});
 const target={_id:shiftId,branchId,operatorId,currency:'UGX',openingMinor:'10000',varianceMinor:'-500',status:'pending_open'};
 const actions=[];const noop={createIndexes:async()=>{}};
 const shifts={createIndexes:async()=>{},findOneAndUpdate:async(filter,update,options)=>{
   assert(options.session,'shift decision must be transactional');
   if(String(filter.operatorId.$ne)===operatorId||String(filter.branchId)!==branchId||filter.status!==target.status)return null;
   const copy={...target,...update.$set};actions.push({filter,update});return copy;
 }};
 const audits={createIndexes:async()=>{},create:async(entries,opts)=>{assert(opts.session);actions.push(entries[0]);}};
 const models={SecureTenantUser:noop,SecureStaffInvite:noop,SecureBranch:noop,SecureCashSession:shifts,
   SecureMobileTransaction:noop,SecureAuditEvent:audits,LedgerAccountV2:noop,LedgerJournalV2:noop,LedgerPostingV2:noop,
   FinancialOperationV1:noop,VerifiedFinancialEvidenceV1:noop,FinancialExceptionV1:noop,TransferContactV1:noop,TransferOrderV1:noop,BankReferenceV1:noop,BankingRequestV1:noop,ForexRateV1:noop,ForexQuoteV1:noop,ApprovalPolicyV1:noop,ApprovalRequestV1:noop,NotificationMessageV1:noop,NotificationTemplateV1:noop,NotificationPreferenceV1:noop,SmsInboxV1:noop};
 const conn={models,startSession:async()=>({withTransaction:async fn=>fn(),endSession:async()=>{}})};
 const manager={id:id(),branchId,role:'Branch Manager',allowedModules:['mobile_money']};
 await assert.rejects(cash.decideOpening(conn,tenant,{...manager,id:operatorId},shiftId,{decision:'approve',note:'Self verification forbidden'}),{status:409});
 await assert.rejects(cash.decideOpening(conn,tenant,{...manager,branchId:otherBranch},shiftId,{decision:'approve',note:'Wrong branch verification'}),{status:409});
 const verified=await cash.decideOpening(conn,tenant,manager,shiftId,{decision:'approve',note:'Opening cash was independently counted'});
 assert.equal(verified.status,'open');assert(actions.some(x=>x.action==='mobile_money.shift.opening_approved'));
 target.status='submitted';actions.length=0;
 await assert.rejects(cash.decide(conn,tenant,manager,shiftId,{decision:'approve',note:'Count discrepancy should escalate'}),{status:403});
 assert(!actions.some(x=>x.action==='mobile_money.shift.approved'));
 const investigator={id:id(),branchId,role:'Reconciliation Officer',allowedModules:['mobile_money']};
 const reconciled=await cash.decide(conn,tenant,investigator,shiftId,{decision:'approve',note:'Reviewed and accepted discrepancy after independent investigation'});
 assert.equal(reconciled.status,'approved');assert(actions.some(x=>x.action==='mobile_money.shift.approved'));
});
test('opening review and report control forms render only for explicitly permitted roles',async()=>{
 const item={_id:shiftId,branchId,operatorId,currency:'UGX',openingMinor:'10000',provisionalMovementMinor:'0',recordCount:0,
   status:'pending_open',createdAt:new Date(),submittedAt:null,closeHistory:[]};
 const f=path.join(__dirname,'../src/views/tenant/mobile-money/shift-detail.ejs');
 const visible=await ejs.renderFile(f,{formatMoneyMinor:mobile.formatMoneyMinor,data:{shift:item,canReviewOpening:true,canSubmit:false,canReview:false},csrfToken:'proof'});
 assert.match(visible,/verify-opening/);assert.match(visible,/name="decision" value="reject"/);
 const hidden=await ejs.renderFile(f,{formatMoneyMinor:mobile.formatMoneyMinor,data:{shift:item,canReviewOpening:false,canSubmit:false,canReview:false},csrfToken:'proof'});
 assert.doesNotMatch(hidden,/verify-opening/);
 const variance=await ejs.renderFile(f,{formatMoneyMinor:mobile.formatMoneyMinor,data:{shift:{...item,status:'submitted',submittedAt:new Date(),declaredClosingMinor:'9000',expectedClosingMinor:'10000',varianceMinor:'-1000'},
   canReviewOpening:false,canSubmit:false,canReview:true,canApprove:false},csrfToken:'proof'});
 assert.doesNotMatch(variance,/name="decision" value="approve"/);
 assert.match(variance,/Tenant Owner or Reconciliation Officer approval/);
});

test('cash close computes exact minor-unit variances for matched, short and excess counts',async()=>{
 const {entitledTenant}=require('./helpers/entitlement');
 const tenant=entitledTenant({enabledModules:['mobile_money']});
 for(const [currency,opening,counted,variance] of [
  ['UGX','120000','120000','0'],['UGX','120000','119000','-1000'],
  ['UGX','120000','121000','1000'],['KES','12345','123.44','-1']
 ]){
  const tx={withTransaction:async fn=>fn(),endSession:async()=>{}};
  const current={_id:shiftId,branchId,operatorId,currency,openingMinor:opening,
   provisionalMovementMinor:'0',recordCount:0,status:'open'};
  const audits=[];
  const noop={createIndexes:async()=>{}};
  const models={
   SecureCashSession:{...noop,findOneAndUpdate:async(filter,update,options)=>{
    assert.equal(options.session,tx);
    assert.equal(String(filter._id),shiftId);
    Object.assign(current,update.$set);return {...current};
   }},
   SecureMobileTransaction:{...noop,countDocuments:()=>({session:async()=>0}),
    aggregate:()=>({session:async()=>[]})},
   ExpenseV1:{...noop,countDocuments:()=>({session:async()=>0}),aggregate:()=>({session:async()=>[]})},
   SecureAuditEvent:{...noop,create:async(rows,options)=>{assert.equal(options.session,tx);audits.push(...rows);}}
  };
  const conn={models,model:name=>models[name]||noop,startSession:async()=>tx};
  const closed=await cash.submit(conn,tenant,operator(),shiftId,{countedCash:counted,
   note:'Physical notes independently counted at the end of the shift'});
  assert.equal(closed.status,'submitted');
  assert.equal(String(closed.expectedClosingMinor),opening);
  assert.equal(String(closed.varianceMinor),variance);
  assert.equal(audits.length,1);
  assert.equal(audits[0].metadata.varianceMinor,variance);
 }
});
