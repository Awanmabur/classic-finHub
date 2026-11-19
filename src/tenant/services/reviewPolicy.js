'use strict';
// Small staffed branches may have the owner or the assigned manager perform
// routine creation and approval. This is NOT permission to alter tenant scope,
// reconcile a discrepancy, self-void a transaction, or reverse the ledger.
// Each caller must still enforce module, permission, branch, idempotency,
// financial posting and audit rules in its own service.
function canSelfReviewRoutine(actor,branchId){
 if(!actor?.id)return false;
 if(actor.role==='Tenant Owner')return true;
 return actor.role==='Branch Manager'&&!!actor.branchId&&
  !!branchId&&String(actor.branchId)===String(branchId);
}
function creatorFilter(actor){
 return canSelfReviewRoutine(actor,actor?.branchId)||actor?.role==='Tenant Owner'?
  {}:{createdBy:{$ne:actor.id}};
}
// A trusted HTTP session is not a substitute for a persisted role fence when
// the same person is also the financial reviewer. Detect role changes/revokes.
async function persistedRoutineReviewer(conn,session,actor,branchId){
 if(!session?.inTransaction()||!canSelfReviewRoutine(actor,branchId))return false;
 const {tenantUserModel}=require('../models');
 const filter={_id:actor.id,status:'active',role:actor.role,
  ...(actor.role==='Branch Manager'?{branchId}: {})};
 const current=await tenantUserModel(conn).findOne(filter)
  .select('_id role branchId authVersion').session(session).lean();
 return Boolean(current)&&Number(current.authVersion||0)===Number(actor.authVersion||0);
}
module.exports={canSelfReviewRoutine,creatorFilter,persistedRoutineReviewer};
