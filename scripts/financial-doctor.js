#!/usr/bin/env node
'use strict';
// Non-mutating, strictly bounded financial operations audit. Access to this
// command is an audited server-side administrative privilege, not an HTTP API.
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection,tenantDbNameFromSlug}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const Tenant=require('../src/platform/models/Tenant');
const {branchModel,financialOperationModel,financialEvidenceModel,financialExceptionModel,
  ledgerJournalModel}=require('../src/tenant/models');
const ledger=require('../src/tenant/services/ledger.service');
const finance=require('../src/tenant/financial/transactionEngine.service');
async function main(){
  const args=process.argv.slice(2);
  if(args.length!==4||args[0]!=='--tenant'||args[2]!=='--branch')
    throw Error('Usage: npm run financial:doctor -- --tenant <registered-slug> --branch <24-character-id>');
  const slug=args[1],branchId=args[3];
  tenantDbNameFromSlug(slug);
  if(!/^[0-9a-f]{24}$/i.test(branchId))throw Error('Invalid branch ID');
  await connectPlatformMongo();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1,maxTimeMS:2000}));
  if(!await Tenant.exists({slug}))throw Error('Tenant not registered');
  const conn=getTenantConnection(slug);
  if(!await branchModel(conn).exists({_id:branchId}))throw Error('Tenant branch does not exist');
  const Operation=financialOperationModel(conn),Evidence=financialEvidenceModel(conn),
    Journal=ledgerJournalModel(conn),Exception=financialExceptionModel(conn);
  const count=await Operation.countDocuments({branchId});
  if(count>500)throw Error('More than 500 operations: a paginated supervised audit is required; no partial pass');
  const operations=await Operation.find({branchId}).sort({_id:1}).limit(501).lean();
  const failures=[];
  for(const op of operations){
    if(op.status==='reconciled'){
      if(!op.journalId){failures.push('reconciled-without-journal:'+op._id);continue;}
      const journal=await Journal.findById(op.journalId).lean();
      if(!journal||journal.sourceType!==op.sourceType||journal.sourceRef!==op.sourceRef||
        String(journal.branchId)!==String(op.branchId)){failures.push('journal-mismatch:'+op._id);continue;}
      try{await ledger.inspectJournal(conn,String(journal._id));}
      catch(e){failures.push('journal-integrity:'+op._id);}
    }
    if(op.status==='provider_verified'||op.status==='reconciled'){
      if(!await Evidence.exists({operationId:op._id,kind:'callback',claimedStatus:'confirmed',matchStatus:'matched'}))
        failures.push('verified-without-callback:'+op._id);
    }
    if(op.status==='reconciled'){
      if(!await Evidence.exists({operationId:op._id,kind:'settlement',claimedStatus:'confirmed',matchStatus:'matched'}))
        failures.push('reconciled-without-statement:'+op._id);
    }
    if(op.status==='reconciled'&&await Exception.exists({operationId:op._id,status:'open'}))
      failures.push('reconciled-with-open-exception:'+op._id);
  }
  const summary=await finance.reconciliationSummary(conn,{branchId});
  console.log(JSON.stringify({event:'financial-doctor',tenant:slug,branchId,checked:operations.length,summary,
    failures:failures.length,readOnly:true}));
  if(failures.length)throw Error('Financial integrity failed: '+failures.slice(0,10).join(', '));
}
main().catch(e=>{console.error('Financial diagnostic FAILED:',e.message);process.exitCode=1;})
  .finally(()=>mongoose.disconnect().catch(()=>{}));
