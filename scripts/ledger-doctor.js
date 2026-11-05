#!/usr/bin/env node
'use strict';
// Bounded, read-only accounting integrity check; no financial or audit data mutation.
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection,tenantDbNameFromSlug}=require('../src/config/mongo');
const Tenant=require('../src/platform/models/Tenant');
const {ledgerJournalModel}=require('../src/tenant/models');
const ledger=require('../src/tenant/services/ledger.service');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
async function main(){
  const args=process.argv.slice(2);
  if(args.length!==4||args[0]!=='--tenant'||args[2]!=='--branch')
    throw Error('Usage: npm run ledger:doctor -- --tenant <registered-slug> --branch <24-character-branch-id>');
  const slug=args[1], branchId=args[3];
  tenantDbNameFromSlug(slug);
  if(!/^[a-f0-9]{24}$/i.test(branchId))throw Error('Invalid branch ID');
  await connectPlatformMongo();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1,maxTimeMS:2000}));
  if(!await Tenant.exists({slug}))throw Error('Tenant not registered');
  const conn=getTenantConnection(slug), Journal=ledgerJournalModel(conn);
  const n=await Journal.countDocuments({branchId});
  // Avoid claiming a partial sample is a complete tenant ledger audit.
  if(n>2000)throw Error('More than 2,000 journals; run a paginated supervised audit instead');
  const docs=await Journal.find({branchId}).sort({_id:1}).limit(2001).select('_id').lean();
  let checked=0;
  for(const j of docs){await ledger.inspectJournal(conn,String(j._id));checked++;}
  const branch=await require('../src/tenant/models').branchModel(conn).findById(branchId).lean();
  if(!branch)throw Error('Registered branch not found');
  const balance=await ledger.trialBalance(conn,{branchId,currency:branch.currency});
  console.log(JSON.stringify({event:'ledger-doctor',tenant:slug,branchId,journalsChecked:checked,
    accountCount:balance.rows.length,balanced:balance.balanced,readOnly:true}));
}
main().catch(e=>{console.error('Ledger integrity FAILED:',e.message);process.exitCode=1;}).finally(()=>mongoose.disconnect().catch(()=>{}));
