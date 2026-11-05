'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {issuesForTenant}=require('../src/platform/services/infrastructureChecks.service');
const {entitledTenant}=require('./helpers/entitlement');
const valid=entitledTenant({slug:'unit-test',enabledModules:['mobile_money'],branchCount:2,seatsReserved:4});
const indexes={
  SecureTenantUser:[{unique:true,key:{email:1}}], SecureBranch:[{unique:true,key:{code:1}}],
  SecureCashSession:[{unique:true,key:{activeKey:1},partialFilterExpression:{activeKey:{$type:'string'}}}],
  SecureStaffInvite:[{unique:true,key:{tokenHash:1}}], SecureMobileTransaction:[{unique:true,key:{idempotencyKey:1}}],
  TransferOrderV1:[{unique:true,key:{idempotencyKey:1}}],
  BankingRequestV1:[{unique:true,key:{idempotencyKey:1}}],
  ForexRateV1:[{unique:true,key:{branchId:1,fromCurrency:1,toCurrency:1},partialFilterExpression:{status:'active'}}],
  ForexQuoteV1:[{unique:true,key:{idempotencyKey:1}}],
  ApprovalPolicyV1:[{unique:true,key:{code:1,version:1}}],
  ApprovalRequestV1:[{unique:true,key:{idempotencyKey:1}}],
  NotificationTemplateV1:[{unique:true,key:{code:1,version:1}}],
  NotificationMessageV1:[{unique:true,key:{dedupeKey:1}}],
  NotificationPreferenceV1:[{unique:true,key:{userId:1}}],
  LedgerAccountV2:[{unique:true,key:{branchId:1,code:1}}],
  LedgerJournalV2:[{unique:true,key:{sourceType:1,sourceRef:1}}],
  LedgerPostingV2:[{unique:true,key:{journalId:1,lineNo:1}}],
  FinancialOperationV1:[{unique:true,key:{sourceType:1,sourceRef:1}}],
  VerifiedFinancialEvidenceV1:[{unique:true,key:{provider:1,kind:1,eventId:1}}],
  FinancialExceptionV1:[{unique:true,key:{evidenceId:1}}]
};
const state={branchCount:2,activeNonOwnerCount:2,pendingInviteCount:1,invalidAssignments:0,indexes};
test('read-only doctor accepts a consistent tenant and required unique indexes',()=>{assert.deepEqual(issuesForTenant(valid,state),[]);});
test('read-only doctor reports drift and missing indexes rather than repairing data',()=>{
 const failures=issuesForTenant({...valid,branchCount:0,seatsReserved:100,enabledModules:['banking']},{...state,invalidAssignments:1,indexes:{}});
 for(const issue of ['branch-counter-drift','seat-counter-drift','seat-plan-limit-exceeded','invalid-staff-branch-assignment','missing-unique-index','invalid-entitlement'])assert(failures.includes(issue));
});

test('expired and revoked grants do not constitute infrastructure corruption',()=>{
 for(const status of ['revoked','granted']){
  const t={...valid,subscription:{...valid.subscription,status,periodEnd:new Date('2020-01-01')}};
  assert.deepEqual(issuesForTenant(t,state),[]);
 }
});
test('broken subscription shape is reported without throwing',()=>{
 const t={...valid,subscription:{planCode:'agent',planVersion:1}};
 const issues=issuesForTenant(t,state);
 assert(issues.includes('missing-or-invalid-subscription'));
});

test('live doctor model registry covers every required index, including approval workflows',async()=>{
 const mongoose=require('mongoose');
 const {tenantIndexModels}=require('../scripts/infra-doctor');
 const {REQUIRED_INDEXES}=require('../src/platform/services/infrastructureChecks.service');
 const conn=mongoose.createConnection();
 try{
  const models=tenantIndexModels(conn);
  for(const key of Object.keys(REQUIRED_INDEXES)){
   assert(models[key],`Missing diagnostic model ${key}`);
   assert.equal(models[key].modelName,key);
   assert.equal(models[key].db,conn,'diagnostic must inspect the selected tenant database');
  }
 }finally{await conn.close();}
});
