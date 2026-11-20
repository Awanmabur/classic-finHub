#!/usr/bin/env node
'use strict';
// Read-only counts for production diagnosis. Never output tenant identities.
const mongoose=require('mongoose');
const {connectPlatformMongo}=require('../src/config/mongo');
const Tenant=require('../src/platform/models/Tenant');
async function main(){
  await connectPlatformMongo();
  try{
    const eligible={status:{$in:['active','trial']},setupStatus:{$ne:'invited'}};
    const publicFilter=require('../src/platform/services/businessDirectory.service').listingFilter();
    const [live,listed,published,byStatus]=await Promise.all([
      Tenant.countDocuments(eligible).maxTimeMS(4000),
      Tenant.countDocuments(publicFilter).maxTimeMS(4000),
      Tenant.countDocuments({...publicFilter,'directory.publishedAt':{$exists:true,$ne:null}}).maxTimeMS(4000),
      Tenant.aggregate([{$group:{_id:{status:'$status',setupStatus:'$setupStatus'},count:{$sum:1}}},{$sort:{'_id.status':1}}]).option({maxTimeMS:4000})
    ]);
    console.log(JSON.stringify({liveBusinessCount:live,listedBusinessCount:listed,
      awaitingListingApproval:Math.max(0,live-listed),detailPublishedCount:published,
      basicApprovedProfiles:Math.max(0,listed-published),statusCounts:byStatus},null,2));
  }finally{await mongoose.disconnect();}
}
main().catch(err=>{console.error('Directory count check failed:',err.code||'STORAGE_ERROR');process.exitCode=1;});
