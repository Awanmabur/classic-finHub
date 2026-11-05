'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Types}=require('mongoose');
const ejs=require('ejs');
const path=require('node:path');
const service=require('../src/tenant/services/mobileMoney.service');
const {permissionsFor}=require('../src/config/roles');
const id=()=>String(new Types.ObjectId());
const operator=id(), reviewer=id(), other=id(), branch=id(), secondBranch=id(), recordId=id();
function matches(actual, expected) {
  if(expected&&typeof expected==='object'&&!Array.isArray(expected)){
    if('$in' in expected)return expected.$in.some(value=>String(actual)===String(value));
    if('$nin' in expected)return !expected.$nin.some(value=>String(actual)===String(value));
    if('$ne' in expected)return String(actual)!==String(expected.$ne);
    if('$lt' in expected)return Number(actual)<Number(expected.$lt);
    if('$exists' in expected)return (actual!==undefined)===expected.$exists;
  }
  return String(actual)===String(expected);
}
function fixture(){
  const row={_id:recordId,operatorId:operator,branchId:branch,correctionState:'none',
    reviewState:'awaiting_review',status:'pending_verification',currency:'UGX',network:'MTN',
    networkReference:'MMREF-1234',amountMinor:'20000',correctionAttempts:0,correctionHistory:[]};
  const audit=[];
  let transactionCount=0;
  const transactions={createIndexes:async()=>{},
    findOneAndUpdate(filter,update,options){
      assert(options.session,'must modify within a DB transaction');
      return {lean:async()=>{
        if(!Object.entries(filter).every(([field,value])=>field==='$or'?value.some(clause=>Object.entries(clause).every(([k,v])=>matches(row[k],v))):matches(row[field],value)))return null;
        Object.assign(row,update.$set);
        if(update.$inc)for(const [key,value] of Object.entries(update.$inc))row[key]=(row[key]||0)+value;
        if(update.$push?.correctionHistory)row.correctionHistory.push(update.$push.correctionHistory);
        return {...row,correctionHistory:[...row.correctionHistory]};
      }};
    },
    find(filter){return {sort(){return this;},limit(){return this;},lean:async()=>Object.entries(filter).every(([key,expect])=>matches(row[key],expect))?[{...row}]:[]};}
  };
  const audits={createIndexes:async()=>{},create:async(items,opts)=>{assert(opts.session);audit.push(...items);}};
  const noop={createIndexes:async()=>{}};
  const conn={models:{SecureMobileTransaction:transactions,SecureAuditEvent:audits,
    SecureTenantUser:noop,SecureStaffInvite:noop,SecureBranch:noop,SecureCashSession:noop,
    LedgerAccountV2:noop,LedgerJournalV2:noop,LedgerPostingV2:noop,
    FinancialOperationV1:noop,VerifiedFinancialEvidenceV1:noop,FinancialExceptionV1:noop,TransferContactV1:noop,TransferOrderV1:noop,BankReferenceV1:noop,BankingRequestV1:noop,ForexRateV1:noop,ForexQuoteV1:noop,ApprovalPolicyV1:noop,ApprovalRequestV1:noop,NotificationMessageV1:noop,NotificationTemplateV1:noop,NotificationPreferenceV1:noop,SmsInboxV1:noop},
    startSession:async()=>({withTransaction:async fn=>{transactionCount++;await fn();},endSession:async()=>{}})};
  return {conn,row,audit,get transactionCount(){return transactionCount;}};
}
test('request, reject, resubmit and independent approval preserve a complete correction history',async()=>{
  const f=fixture(),maker={id:operator,role:'Mobile Money Operator',branchId:branch},officer={id:reviewer,role:'Reconciliation Officer',branchId:branch};
  const initial=await service.requestVoid(f.conn,maker,recordId,'Customer reference was recorded incorrectly');
  assert.equal(initial.correctionState,'requested');
  assert.equal(initial.status,'pending_verification');
  assert.equal(initial.correctionHistory[0].action,'requested');
  assert.equal((await service.getVoidQueue(f.conn,reviewer,25,branch)).length,1);
  assert.equal((await service.getReviewQueue(f.conn,reviewer,25,branch)).length,0,'normal review cannot race a pending void');
  await assert.rejects(service.requestVoid(f.conn,maker,recordId,'Try duplicate void request'),{status:409});
  const denied=await service.decideVoid(f.conn,officer,recordId,'deny','Receipt supports the original entry');
  assert.equal(denied.correctionState,'denied');
  assert.equal(denied.status,'pending_verification');
  assert.equal((await service.getReviewQueue(f.conn,reviewer,25,branch)).length,1);
  await service.requestVoid(f.conn,maker,recordId,'Additional proof: receipt entered with wrong amount');
  const voided=await service.decideVoid(f.conn,officer,recordId,'approve','Checked transaction receipt and customer evidence');
  assert.equal(voided.status,'voided_internal');
  assert.equal(voided.correctionState,'voided');
  assert.deepEqual(voided.correctionHistory.map(x=>x.action),['requested','denied','requested','approved']);
  assert.deepEqual(f.audit.map(x=>x.action),['mobile_money.void.requested','mobile_money.void.denied','mobile_money.void.requested','mobile_money.void.approved']);
  assert.equal(f.audit.length,4,'failed repeated operation must never produce another audit event');
  await assert.rejects(service.requestVoid(f.conn,maker,recordId,'Attempt to resurrect voided record'),{status:409});
  await assert.rejects(service.decideVoid(f.conn,officer,recordId,'approve','Do not change completed state'),{status:409});
  assert.equal(f.row.correctionAttempts,2);
  assert.equal(f.row.networkReference,'MMREF-1234','original financial details remain unchanged');
});
test('cross-branch, self-approval, unauthorized role, and invalid notes fail closed',async()=>{
  const f=fixture();
  await assert.rejects(service.requestVoid(f.conn,{id:other,role:'Mobile Money Operator',branchId:branch},recordId,'A valid correction reason'),{status:409});
  await assert.rejects(service.requestVoid(f.conn,{id:operator,role:'Viewer',branchId:branch},recordId,'A valid correction reason'),{status:403});
  await assert.rejects(service.requestVoid(f.conn,{id:operator,role:'Mobile Money Operator',branchId:secondBranch},recordId,'A valid correction reason'),{status:409});
  await assert.rejects(service.requestVoid(f.conn,{id:operator,role:'Mobile Money Operator',branchId:branch},recordId,'short'),{status:400});
  await service.requestVoid(f.conn,{id:operator,role:'Mobile Money Operator',branchId:branch},recordId,'Recorded amount requires review');
  await assert.rejects(service.decideVoid(f.conn,{id:operator,role:'Tenant Owner'},recordId,'approve','Attempting self-approval'),{status:409});
  await assert.rejects(service.decideVoid(f.conn,{id:reviewer,role:'Reconciliation Officer',branchId:secondBranch},recordId,'approve','Attempting cross-branch approval'),{status:409});
  await assert.rejects(service.decideVoid(f.conn,{id:reviewer,role:'Mobile Money Operator',branchId:branch},recordId,'approve','Attempting operator approval'),{status:403});
  await assert.rejects(service.decideVoid(f.conn,{id:reviewer,role:'Reconciliation Officer',branchId:branch},recordId,'not-a-decision','A detailed enough reason'),{status:400});
  assert.equal(f.audit.length,1);
  assert.equal(f.row.correctionState,'requested');
  assert.equal((await service.getVoidQueue(f.conn,operator,25,branch)).length,0);
  assert.equal((await service.getVoidQueue(f.conn,reviewer,25,secondBranch)).length,0);
});
test('Mobile Money dashboard has scoped correction controls and readable review states',async()=>{
  const file=path.join(__dirname,'../src/views/tenant/mobile-money/index.ejs');
  const record={_id:recordId,operatorId:operator,branchId:branch,network:'MTN',networkReference:'MMREF-1234',
    customer:'Test person',operation:'cash_in',currency:'UGX',amountMinor:'20000',
    status:'pending_verification',reviewState:'awaiting_review',correctionState:'none'};
  const data={summary:{total:1,recent:[record]},branches:[{_id:branch,name:'Branch',status:'active'}],
    canRecord:true,canReview:false,reviewQueue:[],voidQueue:[],idempotencyKey:'ref-id'};
  const render=async(role,userId,overrides={})=>ejs.renderFile(file,{data:{...data,...overrides},user:{id:userId,role,branchId:branch,permissions:permissionsFor(role)},csrfToken:'token',money:(currency,amt)=>`${currency} ${amt}`,amountFromMinor:service.fromMinor});
  const mine=await render('Mobile Money Operator',operator);
  assert.match(mine,/Request void review/);
  assert.match(mine,/name="_csrf" value="token"/);
  assert.doesNotMatch(mine,/Approve internal void/);
  assert.doesNotMatch(await render('Mobile Money Operator',other),/Request void review/);
  const review=await render('Reconciliation Officer',reviewer,{canRecord:false,canReview:true,voidQueue:[{...record,correctionReason:'Incorrect original receipt'}]});
  assert.match(review,/Approve internal void/);
  assert.match(review,/Deny request/);
  assert.doesNotMatch(review,/Request void review/);
  const auditor=await render('Auditor',other,{canRecord:false,canReview:false});
  assert.doesNotMatch(auditor,/Approve internal void|Request void review/);
});
test('CSV explicitly marks voided records without implying network refund',()=>{
  const csv=service.toCsv([{createdAt:new Date('2026-11-03T10:00:00Z'),operation:'cash_in',customer:'Test',
    network:'MTN',networkReference:'MMREF-1234',currency:'UGX',amountMinor:'20000',feeMinor:'0',
    status:'voided_internal',reviewState:'accepted',correctionState:'voided'}]);
  assert.match(csv,/"Correction State"/);
  assert.match(csv,/"voided_internal","accepted","voided"/);
});

test('correction requests are capped; a denied request does not allow unbounded audit history',async()=>{
  const f=fixture(),maker={id:operator,role:'Mobile Money Operator',branchId:branch},officer={id:reviewer,role:'Reconciliation Officer',branchId:branch};
  for(let i=0;i<5;i++){
    await service.requestVoid(f.conn,maker,recordId,'Recorded reference requires further checking');
    await service.decideVoid(f.conn,officer,recordId,'deny','Network receipt does not support a correction');
  }
  assert.equal(f.row.correctionAttempts,5);
  assert.equal(f.row.correctionHistory.length,10);
  await assert.rejects(service.requestVoid(f.conn,maker,recordId,'Sixth correction request not allowed'),{status:409});
  assert.equal(f.audit.length,10);
});
test('read-only Viewer sees decision chronology but not investigator notes',()=>{
  const record={_id:recordId,correctionHistory:[{action:'requested',at:new Date(),note:'Sensitive customer statement'}]};
  const visible=service.visibleRecordForRole(record,'Viewer');
  assert.equal(visible.correctionHistory[0].note,'Restricted to operational staff');
  assert.equal(record.correctionHistory[0].note,'Sensitive customer statement');
  assert.equal(service.visibleRecordForRole(record,'Reconciliation Officer'),record);
});
