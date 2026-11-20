#!/usr/bin/env node
'use strict';
// Reconcile only owner-published public snapshots. Dry-run unless --apply.
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const Tenant=require('../src/platform/models/Tenant');
const {publicLanding}=require('../src/tenant/workspace/service');
const directory=require('../src/platform/services/businessDirectory.service');
async function main(){
  const apply=process.argv.includes('--apply');
  if(process.argv.some(arg=>arg.startsWith('--')&&arg!=='--apply'))
    throw new Error('Only --apply is supported');
  await connectPlatformMongo();
  let after=null,scanned=0,eligible=0,updated=0,errors=0;
  try{
    while(true){
      const filter={status:{$in:['active','trial']},setupStatus:{$ne:'invited'},...(after?{_id:{$gt:after}}:{})};
      const batch=await Tenant.find(filter).sort({_id:1}).limit(50).select('_id slug dbName status directory').lean();
      if(!batch.length)break;
      for(const tenant of batch){
        scanned++;after=tenant._id;
        try{
          const landing=await publicLanding(getTenantConnection(tenant.slug),tenant);
          if(!landing||!directory.publicSnapshot(landing,landing.publishedAt))continue;
          eligible++;
          if(apply){await directory.sync(tenant,landing,landing.publishedAt);updated++;}
        }catch(error){
          errors++;
          console.error(JSON.stringify({event:'directory_reconciliation_failed',slug:tenant.slug,code:error.code||'ERROR'}));
        }
      }
      if(batch.length<50)break;
    }
    console.log(JSON.stringify({mode:apply?'apply':'dry-run',scanned,eligible,updated,errors}));
    if(errors)process.exitCode=1;
  }finally{await mongoose.disconnect();}
}
main().catch(e=>{console.error('Directory reconciliation failed:',e.code||e.message);process.exitCode=1;});
