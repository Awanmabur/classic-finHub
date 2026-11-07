'use strict';
const {modules}=require('../../data/store');
const {effectiveSubscription,limitsFor}=require('./commercial.service');
const {activeGrants}=require('./moduleSubscriptions.service');
const REQUIRED_INDEXES=Object.freeze({
  TreasuryAccountV1: [['branchId',1],['code',1]],
  TreasuryObservationV1: [['idempotencyKey',1]],
  TreasuryBatchV1: [['sourceType',1],['sourceRef',1]],
  TreasuryMovementV1: [['accountId',1],['sequence',1]],
  TreasuryCounterV1: [['branchId',1],['currency',1],['purpose',1]],
  TreasuryAdjustmentV1: [['idempotencyKey',1]],
  TreasuryFundingV1: [['idempotencyKey',1]],
  FundedExecutionV1: [['idempotencyKey',1]],
  ManualPayoutVerificationV1: [['tokenHash',1]],
  CustomerDirectoryV1: [['reference',1]],
  CustomerAccountV1: [['accountNumber',1]],
  TenantWorkspaceConfigV1: [['tenantId',1]],
  ExpenseV1: [['idempotencyKey',1]],
  SecureTenantUser: [['email',1]],
  SecureBranch: [['code',1]],
  SecureCashSession: [['activeKey',1]],
  SecureStaffInvite: [['tokenHash',1]],
  SecureMobileTransaction: [['idempotencyKey',1]],
  TransferOrderV1: [['idempotencyKey',1]],
  BankingRequestV1: [['idempotencyKey',1]],
  ForexRateV1: [['branchId',1],['fromCurrency',1],['toCurrency',1]],
  ForexQuoteV1: [['idempotencyKey',1]],
  ApprovalPolicyV1: [['code',1],['version',1]],
  ApprovalRequestV1: [['idempotencyKey',1]],
  NotificationTemplateV1: [['code',1],['version',1]],
  NotificationMessageV1: [['dedupeKey',1]],
  NotificationPreferenceV1: [['userId',1]],
  LedgerAccountV2: [['branchId',1],['code',1]],
  LedgerJournalV2: [['sourceType',1],['sourceRef',1]],
  LedgerPostingV2: [['journalId',1],['lineNo',1]],
  FinancialOperationV1: [['sourceType',1],['sourceRef',1]],
  VerifiedFinancialEvidenceV1: [['provider',1],['kind',1],['eventId',1]],
  FinancialExceptionV1: [['evidenceId',1]],
});
function issuesForTenant(tenant,{branchCount,activeNonOwnerCount,pendingInviteCount,invalidAssignments,indexes}={}){
  const issues=[];
  // Expired/revoked subscriptions are ordinary commercial states, not broken
  // infrastructure. Verify structural consistency without granting access.
  const plan=tenant.subscription;
  if((!plan && !activeGrants(tenant).length) || (plan && (plan.planCode!==tenant.plan || !Number.isSafeInteger(plan.planVersion) ||
    !plan.limits || !Array.isArray(plan.modules))))issues.push('missing-or-invalid-subscription');
  const allowed=new Set(plan?.modules||[]);
  if(!Array.isArray(tenant.enabledModules) || tenant.enabledModules.some(key=>!allowed.has(key)||!modules.some(m=>m.key===key)))issues.push('invalid-entitlement');
  if(Array.isArray(tenant.moduleGrants) && (new Set(tenant.moduleGrants.map(g=>g.moduleKey)).size!==tenant.moduleGrants.length ||
    tenant.moduleGrants.some(g=>!modules.some(m=>m.key===g.moduleKey)||!['granted','revoked'].includes(g.status))))issues.push('invalid-module-grants');
  if(!Number.isSafeInteger(branchCount)||tenant.branchCount!==branchCount)issues.push('branch-counter-drift');
  if(limitsFor(tenant) && branchCount>limitsFor(tenant).branches)issues.push('branch-plan-limit-exceeded');
  if(!Number.isSafeInteger(activeNonOwnerCount)||!Number.isSafeInteger(pendingInviteCount)||tenant.seatsReserved!==1+activeNonOwnerCount+pendingInviteCount)issues.push('seat-counter-drift');
  if(limitsFor(tenant) && tenant.seatsReserved>limitsFor(tenant).users)issues.push('seat-plan-limit-exceeded');
  if(!Number.isSafeInteger(invalidAssignments) || invalidAssignments>0)issues.push('invalid-staff-branch-assignment');
  if(!indexes || Object.entries(REQUIRED_INDEXES).some(([key,pattern])=>!Array.isArray(indexes[key])||
    !indexes[key].some(index=>index.unique===true&&Object.keys(index.key||{}).length===pattern.length&&pattern.every(([field,order])=>index.key?.[field]===order) && (key!=='ForexRateV1'||index.partialFilterExpression?.status==='active'))))issues.push('missing-unique-index');
  return issues;
}
module.exports={issuesForTenant,REQUIRED_INDEXES};
