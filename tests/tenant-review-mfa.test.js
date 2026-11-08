'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { permissionsFor, requiresTenantMfa, INVITABLE } = require('../src/config/roles');
const mfa = require('../src/platform/services/mfa.service');
const mobile = require('../src/tenant/services/mobileMoney.service');
const { tenantMenu } = require('../src/services/menu.service');
const tenantModels = require('../src/tenant/models');
const userId = String(new Types.ObjectId()), reviewerId = String(new Types.ObjectId());
const recordId = String(new Types.ObjectId());

function fakeConnection() {
  const record = { _id: new Types.ObjectId(recordId), operatorId: new Types.ObjectId(userId),
    network:'MTN', operation:'cash_in', status:'pending_verification',
    amountMinor:'120000',currency:'UGX', networkReference:'N1234567', reviewState:'awaiting_review' };
  const logs = [];
  const transactions = { findOneAndUpdate(filter, update, opts) {
    assert.equal(opts.new, true);
    assert(opts.session);
    return { lean: async() => {
      if (filter._id !== recordId || String(record.operatorId) === String(filter.operatorId.$ne) ||
          record.status !== filter.status || !filter.reviewState.$in.includes(record.reviewState)) return null;
      Object.assign(record, update.$set);
      return {...record};
    } };
  }, createIndexes:async()=>{} };
  const audit = { async create(items, {session}) {
    assert(session);
    logs.push(...items);
  }, createIndexes:async()=>{} };
  const conn = { models: {
    SecureMobileTransaction:transactions, SecureAuditEvent:audit,
    SecureTenantUser:{createIndexes:async()=>{}}, SecureStaffInvite:{createIndexes:async()=>{}},SecureBranch:{createIndexes:async()=>{}},SecureCashSession:{createIndexes:async()=>{}},
    LedgerAccountV2:{createIndexes:async()=>{}},LedgerJournalV2:{createIndexes:async()=>{}},LedgerPostingV2:{createIndexes:async()=>{}},
    FinancialOperationV1:{createIndexes:async()=>{}},VerifiedFinancialEvidenceV1:{createIndexes:async()=>{}},FinancialExceptionV1:{createIndexes:async()=>{}},TransferContactV1:{createIndexes:async()=>{}},TransferOrderV1:{createIndexes:async()=>{}},BankReferenceV1:{createIndexes:async()=>{}},BankingRequestV1:{createIndexes:async()=>{}},ForexRateV1:{createIndexes:async()=>{}},ForexQuoteV1:{createIndexes:async()=>{}},ApprovalPolicyV1:{createIndexes:async()=>{}},ApprovalRequestV1:{createIndexes:async()=>{}},NotificationMessageV1:{createIndexes:async()=>{}},NotificationTemplateV1:{createIndexes:async()=>{}},NotificationPreferenceV1:{createIndexes:async()=>{}},SmsInboxV1:{createIndexes:async()=>{}},TransferSmsDeliveryV1:{createIndexes:async()=>{}}
  }, async startSession() { return {withTransaction: async fn => fn(), endSession:async()=>{}}; } };
  return { conn, record, logs };
}

test('privileged tenant roles require MFA, only reviewers may approve, and view menus are permission scoped',()=>{
  assert(requiresTenantMfa('Tenant Owner'));
  assert(requiresTenantMfa('Reconciliation Officer'));
  assert(requiresTenantMfa('Auditor'));
  assert(requiresTenantMfa('Branch Manager'));
  assert(!requiresTenantMfa('Mobile Money Operator'));
  assert(INVITABLE.includes('Reconciliation Officer'));
  assert(permissionsFor('Reconciliation Officer').includes('mobile_money.review'));
  assert(!permissionsFor('Auditor').includes('mobile_money.review'));
  assert(!permissionsFor('Mobile Money Operator').includes('mobile_money.review'));
  const tenant = {plan:'agent',enabledModules:['mobile_money']};
  const reviewerMenu=tenantMenu(tenant,{permissions:permissionsFor('Reconciliation Officer')});
  assert(reviewerMenu.some(group=>group.items.some(i=>i.href==='/tenant/audit')));
  const operatorMenu=tenantMenu(tenant,{permissions:permissionsFor('Mobile Money Operator')});
  assert(!operatorMenu.some(group=>group.items.some(i=>i.href==='/tenant/audit')));
});

test('pending tenant MFA session requires both tenant and user IDs and expires',()=>{
  const now=Date.now();
  const state={session:{pendingMfa:{kind:'tenant',tenantId:'tenant-id',tenantUserId:userId,identityId:'identity-id',authVersion:0,startedAt:now,attempts:0}}};
  assert(mfa.pendingSession(state));
  state.session.pendingMfa.platformId='admin-id';
  assert.equal(mfa.pendingSession(state),null);
  delete state.session.pendingMfa.platformId;
  state.session.pendingMfa.tenantUserId=undefined;
  assert.equal(mfa.pendingSession(state),null);
});

test('second-person reviewer accepts only a pending record and writes audit in same transaction',async()=>{
  const {conn,record,logs}=fakeConnection();
  const user={id:reviewerId,role:'Tenant Owner'};
  const result=await mobile.reviewMobileMoney(conn,user,recordId,'accepted','Checked receipt and reference');
  assert.equal(result.reviewState,'accepted');
  assert.equal(record.status,'pending_verification','internal decision must never claim provider settlement');
  assert.equal(result.reviewedBy,reviewerId);
  assert.equal(logs.length,1);
  assert.equal(logs[0].action,'mobile_money.review.accepted');
  await assert.rejects(mobile.reviewMobileMoney(conn,user,recordId,'accepted','Checked receipt and reference'),e=>e.status===409);
  assert.equal(logs.length,1,'replay must not create another audit event');
});

test('reviewer cannot approve own transaction, and unsupported roles cannot approve any',async()=>{
  const {conn,logs}=fakeConnection();
  await assert.rejects(mobile.reviewMobileMoney(conn,{id:userId,role:'Tenant Owner'},recordId,'accepted','Checked receipt and reference'),e=>e.status===409);
  await assert.rejects(mobile.reviewMobileMoney(conn,{id:reviewerId,role:'Auditor'},recordId,'disputed','Disputed due to receipt mismatch'),e=>e.status===403);
  assert.equal(logs.length,0);
});

test('review validates decision, reason and record ID before touching the database',async()=>{
  const {conn}=fakeConnection();
  const reviewer={id:reviewerId,role:'Tenant Owner'};
  await assert.rejects(mobile.reviewMobileMoney(conn,reviewer,recordId,'verified','Checked receipt and reference'),e=>e.status===400);
  await assert.rejects(mobile.reviewMobileMoney(conn,reviewer,recordId,'accepted','no'),e=>e.status===400);
  await assert.rejects(mobile.reviewMobileMoney(conn,reviewer,'badid','accepted','Checked receipt and reference'),e=>e.status===400);
});

test('CSV exports label internal review separately from operational status and escape malicious notes',()=>{
  const csv=mobile.toCsv([{createdAt:new Date('2026-11-03T11:00:00Z'),operation:'cash_in',customer:'Test',network:'MTN',networkReference:'N1234567',currency:'UGX',amountMinor:'120000',feeMinor:'300',status:'pending_verification',reviewState:'disputed',reviewNote:'=HYPERLINK("bad")',reviewedAt:new Date('2026-11-03T12:00:00Z')}]);
  assert.match(csv,/"Operational Record Status","Internal Review"/);
  assert.match(csv,/"pending_verification","disputed"/);
  assert.match(csv,/"'=HYPERLINK\(""bad""\)"/);
});

test('MFA version filtering supports legacy records without a stored version but rejects stale upgraded sessions',()=>{
  assert.deepEqual(mfa.authVersionFilter(0),{$in:[0,null]});
  assert.equal(mfa.authVersionFilter(3),3);
});
