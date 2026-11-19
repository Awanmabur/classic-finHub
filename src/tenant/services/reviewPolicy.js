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
module.exports={canSelfReviewRoutine,creatorFilter};
