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
    const [live,published,byStatus]=await Promise.all([
      Tenant.countDocuments(eligible).maxTimeMS(4000),
      Tenant.countDocuments({...eligible,'directory.publishedAt':{$exists:true,$ne:null}}).maxTimeMS(4000),
      Tenant.aggregate([{$group:{_id:{status:'$status',setupStatus:'$setupStatus'},count:{$sum:1}}},{$sort:{'_id.status':1}}]).option({maxTimeMS:4000})
    ]);
    console.log(JSON.stringify({liveBusinessCount:live,detailPublishedCount:published,
      basicProfiles:Math.max(0,live-published),statusCounts:byStatus},null,2));
  }finally{await mongoose.disconnect();}
}
main().catch(err=>{console.error('Directory count check failed:',err.code||'STORAGE_ERROR');process.exitCode=1;});
