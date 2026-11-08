'use strict';
const crypto=require('node:crypto'),core=require('../models');
// Explicit export projections: no users' auth state, raw SMS, access tokens,
// PINs, notification payloads, arbitrary audit metadata or integration secrets.
function definitions(conn){const treasury=require('../treasury/models').models(conn),funded=require('../funded/models').models(conn),directory=require('../customerAccounts/models'),workspace=require('../workspace/models').models(conn);return [
 ['branches',core.branchModel(conn),'name code currency currencies status createdAt updatedAt address revision createdBy updatedBy','_id'],
 ['staff',core.tenantUserModel(conn),'name email role branchId status createdAt updatedAt permissions allowedModules','branchId'],
 ['mobileMoney',core.mobileTransactionModel(conn),'operation customer customerPhone network networkReference amountMinor feeMinor currency status reviewState operatorId branchId cashSessionId walletAccountId paymentAccountId feeTreatment physicalCashMovementMinor fundingState fundsSourceRef fundJournalIds entrySource reviewedBy reviewedAt reviewNote correctionState correctionReason correctionRequestedBy correctionRequestedAt correctionReviewedBy correctionReviewedAt correctionReviewNote createdAt customerAccountId observedWalletBalance observationEvidenceReference walletBalanceBeforeMinor walletBalanceAfterMinor walletObservationId smsInboxId idempotencyKey customerNote paymentMethod correctionAttempts correctionHistory verifiedBy verifiedAt verificationNote','branchId'],
 ['cashSessions',core.cashSessionModel(conn),'branchId operatorId currency status openingMinor openingStatus openingApprovedBy openingApprovedAt provisionalMovementMinor countedMinor varianceMinor openedAt closedAt submittedAt reviewedAt reviewedBy createdAt updatedAt activeKey treasuryAccountId treasuryBoundAt treasuryBaselineMinor treasuryObservationId treasuryOpeningObservationId openingVerifiedBy openingVerifiedAt openingReviewNote recordCount declaredClosingMinor expectedClosingMinor reviewNote closeHistory revision','branchId'],
 ['transferOrders',core.transferOrderModel(conn),'reference branchId destinationBranchId originBranchName destinationBranchName createdBy sender beneficiary currency amountMinor feeMinor status capture validDays expiresAt manualCollectionExecutionId manualPayoutExecutionId manualPostedAt reviewedBy reviewedAt createdAt updatedAt partyEntryMode idempotencyKey reviewNote cancelledAt cancelledBy cancelReason expiredAt revision','branchId'],
 ['transferContacts',core.transferContactModel(conn),'branchId kind fullName phone country active createdBy updatedBy createdAt updatedAt revision','branchId'],
 ['bankingRequests',core.bankingRequestModel(conn),'reference branchId createdBy kind source destination currency amountMinor status capture manualExecutionId manualPostedAt reviewedBy reviewedAt createdAt updatedAt idempotencyKey note validDays expiresAt reviewNote cancelledBy cancelledAt cancelReason expiredAt revision','branchId'],
 ['bankReferences',core.bankReferenceModel(conn),'branchId label kind accountNumber currency institution active createdAt updatedAt customerName institutionName last4 status createdBy updatedBy revision','branchId'],
 ['forexRates',core.forexRateModel(conn),'branchId fromCurrency toCurrency rateDecimal status validUntil createdBy reviewedBy reviewedAt createdAt updatedAt proposedBy expiresAt note reviewNote revision','branchId'],
 ['forexQuotes',core.forexQuoteModel(conn),'reference branchId createdBy operation fromCurrency toCurrency sourceMinor targetMinor rateId rateDecimal status capture customerLabel customerPhone expiresAt manualExecutionId manualPostedAt createdAt updatedAt idempotencyKey validMinutes note reviewedBy reviewedAt reviewNote cancelledBy cancelledAt cancelNote expiredAt revision','branchId'],
 ['customers',directory.customerModel(conn),'reference branchId name phone email country type idType idNumber address nextOfKin status createdBy createdAt updatedAt updatedBy revision idempotencyKey normalizedName identityNumber nextOfKinName nextOfKinPhone relationship city note archivedAt','branchId'],
 ['customerAccounts',directory.accountModel(conn),'reference branchId customerId accountNumber type currency ledgerAccountId status officer purpose risk createdBy createdAt updatedAt updatedBy revision idempotencyKey','branchId'],
 ['fundAccounts',treasury.account,'tenantId branchId code name kind moduleKey network currency operatorId accountReference feeTreatment ledgerAccountId ledgerCode status openingBalanceMinor openingObservedAt openingApprovedAt bookBalanceMinor sequence reconciliationState lastObservationAt lastObservedMinor lastVarianceMinor createdAt updatedAt selectionKey openingObservationId revision lastObservationId lastExpectedAtObservationMinor holdReason lastObservationStale pendingOpeningId createdBy','branchId'],
 ['fundObservations',treasury.observation,'tenantId branchId accountId kind observedAt actualMinor expectedMinorAtRequest varianceMinorAtRequest evidenceType evidenceReference note requestedBy status reviewedBy reviewedAt reviewNote expectedMinorAtReview varianceMinorAtReview openingJournalId createdAt idempotencyKey evidenceDigest','branchId'],
 ['fundBatches',treasury.batch,'tenantId branchId actorId operatingActorId sourceType sourceRef description evidenceReference occurredAt journalIds reversesBatchId createdAt fingerprint','branchId'],
 ['fundMovements',treasury.movement,'tenantId branchId accountId batchId sourceType sourceRef sequence currency deltaMinor balanceAfterMinor occurredAt actorId journalId createdAt','branchId'],
 ['fundCounters',treasury.counter,'tenantId branchId currency purpose ledgerAccountId ledgerCode','branchId'],
 ['fundAdjustments',treasury.adjustment,'tenantId branchId accountId observationId deltaMinor reason requestedBy status reviewedBy reviewedAt reviewNote batchId createdAt idempotencyKey','branchId'],
 ['fundedExecutions',funded.execution,'sourceType sourceId sourceReference action branchId createdBy accounts collectionExecutionId evidenceReference note status reviewedBy reviewedAt reviewNote journalIds createdAt updatedAt idempotencyKey fingerprint sourceFingerprint sourceSnapshot verificationInfo activeKey revision','branchId'],
 ['ledgerAccounts',core.ledgerAccountModel(conn),'branchId code name category currency createdBy createdAt','branchId'],
 ['ledgerJournals',core.ledgerJournalModel(conn),'branchId currency sourceType sourceRef actorId reverses approval fingerprint createdAt','branchId'],
 ['ledgerPostings',core.ledgerPostingModel(conn),'journalId branchId accountId currency lineNo side amountMinor createdAt','branchId'],
 ['expenses',require('../models/expenses').expenseModel(conn),'branchId reference date amountMinor currency category description payee paymentMethod status createdBy reviewedBy reviewedAt reviewNote cashSessionId fundAccountId journalIds createdAt updatedAt recordReference idempotencyKey operatorId treasuryAccountId sourcePolicy postedTreasuryAccountId treasuryBatchId lastReversalBatchId postingSequence expenseType vendor original correctionState pendingChange history revision','branchId'],
 ['approvalPolicies',core.approvalPolicyModel(conn),'branchId name type amountMinor currency status createdBy createdAt updatedAt code version category steps expiresHours retiredBy retiredAt','branchId'],
 ['approvalRequests',core.approvalRequestModel(conn),'reference branchId createdBy policyId type title description amountMinor currency status reviewedBy reviewedAt reviewNote createdAt updatedAt idempotencyKey policyCode policyVersion policyName category steps subject justification requesterId currentStep decisions expiresAt terminalBy terminalAt terminalNote revision','branchId'],
 ['workspaceProfile',workspace.config,'tenantId profile branding updatedAt revision landing updatedBy createdAt','tenantOnly']
 ];}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object'){if(typeof value.toJSON==='function')return canonical(value.toJSON());return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));}return value;}
async function capture(conn,tenant,policy){
 const session=await conn.startSession();let result;
 try{await session.withTransaction(async()=>{
  const tables={},maxBytes=25*1024*1024;let count=0,bytes=0;
  for(const [name,Model,projection,scopeField]of definitions(conn)){
   if(policy.branchId&&scopeField==='tenantOnly')continue;
   let filter=policy.branchId?{[scopeField]:policy.branchId}:{};
   // A branch archive includes its incoming transfer instructions, never the
   // other branch's cash accounts, ledger lines or raw collection execution.
   if(policy.branchId&&name==='transferOrders')filter={$or:[{branchId:policy.branchId},{destinationBranchId:policy.branchId,status:{$in:['collected_manual','paid_out_manual']}}]};
   const rows=[];for await(const row of Model.find(filter).select(projection).sort({_id:1}).session(session).lean().cursor()){
    const clean=canonical(row);bytes+=Buffer.byteLength(JSON.stringify(clean));if(++count>200000||bytes>maxBytes)throw Object.assign(new Error('Tenant archive exceeds export capacity; use the full replica backup'),{code:'BACKUP_SNAPSHOT_LIMIT'});rows.push(clean);
   }tables[name]=rows;
  }
  const data={format:'classicfin-business-archive-v1',tenantId:String(tenant._id),scopeKey:policy.scopeKey,tables};const json=JSON.stringify(canonical(data));result={data:JSON.parse(json),digest:crypto.createHash('sha256').update(json).digest('hex'),recordCount:count};
 },{readConcern:{level:'snapshot'},readPreference:'primary'});return result;}finally{await session.endSession();}
}
module.exports={definitions,canonical,capture};
