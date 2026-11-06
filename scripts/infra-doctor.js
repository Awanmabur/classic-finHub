#!/usr/bin/env node
'use strict';
// READ-ONLY production-safe tenant/infrastructure diagnostic. Does not repair or reveal user data.
const mongoose=require('mongoose');
const Tenant=require('../src/platform/models/Tenant');
const PlanVersion=require('../src/platform/models/PlanVersion');
const UsageCounter=require('../src/platform/models/UsageCounter');
const ModuleRequest=require('../src/platform/models/ModuleRequest');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const {tenantUserModel,staffInviteModel,branchModel,cashSessionModel,mobileTransactionModel,ledgerAccountModel,ledgerJournalModel,ledgerPostingModel,financialOperationModel,financialEvidenceModel,financialExceptionModel,transferOrderModel,bankingRequestModel,forexRateModel,forexQuoteModel,approvalPolicyModel,approvalRequestModel,notificationTemplateModel,notificationMessageModel,notificationPreferenceModel}=require('../src/tenant/models');
const {issuesForTenant,REQUIRED_INDEXES}=require('../src/platform/services/infrastructureChecks.service');
function tenantIndexModels(conn){
  return {CustomerDirectoryV1:require('../src/tenant/customerAccounts/models').customerModel(conn),CustomerAccountV1:require('../src/tenant/customerAccounts/models').accountModel(conn),
    ExpenseV1:require('../src/tenant/models/expenses').expenseModel(conn),TenantWorkspaceConfigV1:require('../src/tenant/workspace/models').models(conn).config,SecureTenantUser:tenantUserModel(conn),SecureBranch:branchModel(conn),SecureCashSession:cashSessionModel(conn),SecureStaffInvite:staffInviteModel(conn),SecureMobileTransaction:mobileTransactionModel(conn),
    LedgerAccountV2:ledgerAccountModel(conn),LedgerJournalV2:ledgerJournalModel(conn),LedgerPostingV2:ledgerPostingModel(conn),
    FinancialOperationV1:financialOperationModel(conn),VerifiedFinancialEvidenceV1:financialEvidenceModel(conn),
    FinancialExceptionV1:financialExceptionModel(conn),TransferOrderV1:transferOrderModel(conn),BankingRequestV1:bankingRequestModel(conn),ForexRateV1:forexRateModel(conn),ForexQuoteV1:forexQuoteModel(conn),
    ApprovalPolicyV1:approvalPolicyModel(conn),ApprovalRequestV1:approvalRequestModel(conn),
    NotificationTemplateV1:notificationTemplateModel(conn),NotificationMessageV1:notificationMessageModel(conn),
    NotificationPreferenceV1:notificationPreferenceModel(conn)};
}
async function inspect(tenant){
  const conn=getTenantConnection(tenant.slug);
  const User=tenantUserModel(conn), Invite=staffInviteModel(conn), Branch=branchModel(conn);
  const [branchCount,activeNonOwnerCount,pendingInviteCount,assignments,activeBranches,unassignedCount]=await Promise.all([
    Branch.countDocuments({status:'active'}),
    User.countDocuments({status:'active',role:{$ne:'Tenant Owner'}}),
    Invite.countDocuments({status:'pending'}),
    User.distinct('branchId',{status:'active',role:{$ne:'Tenant Owner'}}),
    Branch.find({status:'active'}).select('_id').lean(),
    User.countDocuments({status:'active',role:{$ne:'Tenant Owner'},$or:[{branchId:{$exists:false}},{branchId:null},{branchId:''}]})
  ]);
  const branchIds=new Set(activeBranches.map(b=>String(b._id)));
  const invalidAssignments=unassignedCount+assignments.filter(b=>b&&!branchIds.has(String(b))).length;
  const models=tenantIndexModels(conn);
  const indexes={};
  for(const key of Object.keys(REQUIRED_INDEXES)){
    try{indexes[key]=await models[key].collection.indexes();}catch{indexes[key]=[];}
  }
  return issuesForTenant(tenant,{branchCount,activeNonOwnerCount,pendingInviteCount,invalidAssignments,indexes});
}
async function main(){
  await connectPlatformMongo();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1,maxTimeMS:2000}));
  let inspected=0,failures=0;
  // Commercial consistency is just as critical as the tenant financial indexes.
  for(const [Model,fields] of [[PlanVersion,['code','version']],[UsageCounter,['tenantId','generation','period','metric']]]){
    try{
      const indexes=await Model.collection.indexes();
      const valid=indexes.some(i=>i.unique===true&&Object.keys(i.key||{}).length===fields.length&&fields.every(f=>i.key[f]===1));
      if(!valid){failures++;console.error(JSON.stringify({scope:'platform',model:Model.modelName,issue:'missing-unique-index'}));}
    }catch{failures++;console.error(JSON.stringify({scope:'platform',model:Model.modelName,issue:'index-inspection-failed'}));}
  }
  try{
    const requestIndexes=await ModuleRequest.collection.indexes();
    const valid=requestIndexes.some(i=>i.unique===true&&i.key?.tenantId===1&&i.key?.moduleKey===1&&
      i.partialFilterExpression?.status==='pending');
    if(!valid){failures++;console.error(JSON.stringify({scope:'platform',model:'ModuleRequest',issue:'missing-pending-request-unique-index'}));}
  }catch{failures++;console.error(JSON.stringify({scope:'platform',model:'ModuleRequest',issue:'index-inspection-failed'}));}
  const published=await PlanVersion.countDocuments({status:'published'});
  if(!published){failures++;console.error(JSON.stringify({scope:'platform',issue:'no-published-plan-versions'}));}
  for await(const tenant of Tenant.find({}).select('slug plan status subscription enabledModules moduleGrants seatsReserved branchCount').lean().cursor()){
    inspected++;
    try{
      const issues=await inspect(tenant);
      if(issues.length){failures++;console.error(JSON.stringify({tenant:tenant.slug,issues}));}
    }catch(e){failures++;console.error(JSON.stringify({tenant:tenant.slug,issues:['database-read-failed'],message:e.message}));}
  }
  console.log(JSON.stringify({event:'infra-doctor',inspectedTenants:inspected,failedTenants:failures,readOnly:true}));
  if(failures)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error('Infrastructure diagnostic failed:',e.message);process.exitCode=1;}).finally(()=>mongoose.disconnect());
module.exports={tenantIndexModels,inspect,main};
