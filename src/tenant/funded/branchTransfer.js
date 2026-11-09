'use strict';
// A narrow authorization for reclassifying the originating transfer payable.
// It cannot authorize arbitrary accounts, branches, amounts or cash movements.
const core=require('../models');
const funded=require('./models');
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
async function validate(conn,session,tenant,actor,payoutId){
 if(!session?.inTransaction())throw fail('Branch transfers require one database transaction');
 const authorization=await require('../services/financialAuthorization.service').fenceAction(conn,session,actor,tenant,'money_transfer','money_transfer.review');
 const reviewer=await core.tenantUserModel(conn).findOne({_id:actor.id,status:'active',...(require('../../config/mfaPolicy').enabled()?{mfaEnabledAt:{$ne:null}}:{})}).session(session).lean();
 if(!reviewer||!['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(reviewer.role))throw fail('Independent branch transfer reviewer required',403);
 const execution=await funded.models(conn).execution.findOne({_id:payoutId,action:'transfer_payout',sourceType:'money_transfer',status:'pending_review',createdBy:{$ne:actor.id}}).session(session).lean();
 if(!execution||(reviewer.role!=='Tenant Owner'&&String(reviewer.branchId)!==String(execution.branchId)))throw fail('Payout is outside the reviewer branch',403);
 const source=await core.transferOrderModel(conn).findOne({_id:execution.sourceId,status:'collected_manual',destinationBranchId:execution.branchId}).session(session).lean();
 const collection=await funded.models(conn).execution.findOne({_id:execution.collectionExecutionId,action:'transfer_collect',status:'posted_manual',sourceId:execution.sourceId}).session(session).lean();
 const service=require('../services/fundedOperations.service');
 if(!source||!collection||String(source.branchId)===String(execution.branchId)||String(collection.branchId)!==String(source.branchId)||String(source.manualCollectionExecutionId)!==String(collection._id)||String(collection.accounts.clearingAccountId)!==String(execution.accounts.clearingAccountId)||!service.sourceMatches(execution,source)||!service.sourceMatches(collection,source))throw fail('Branch transfer source or collection integrity changed');
 return {authorization,execution,source,collection};
}
module.exports={validate};
