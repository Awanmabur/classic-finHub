#!/usr/bin/env node
'use strict';
// Explicit, conservative migration. Trials with a reliable expiry can be
// snapshotted; legacy active tenants are never granted a paid term by guessing.
const mongoose=require('mongoose');
const Tenant=require('../src/platform/models/Tenant');
const PlatformAuditLog=require('../src/platform/models/PlatformAuditLog');
const {connectPlatformMongo}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const {latestPublished,planSnapshot}=require('../src/platform/services/commercial.service');
async function main(){
  const apply=process.argv.includes('--apply');
  await connectPlatformMongo();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
  const entries=[];
  for await(const tenant of Tenant.find({subscription:{$exists:false}}).cursor()){
    if(tenant.status!=='trial'||!tenant.trialEndsAt||!tenant.createdAt){
      entries.push({slug:tenant.slug,result:'requires-manual-platform-grant'});continue;
    }
    const doc=await latestPublished(tenant.plan);
    if(!doc){entries.push({slug:tenant.slug,result:'published-plan-missing'});continue;}
    const start=new Date(tenant.createdAt),end=new Date(tenant.trialEndsAt);
    if(!(end>start)) {entries.push({slug:tenant.slug,result:'invalid-trial-dates'});continue;}
    const snap=planSnapshot(doc);
    if(tenant.seatsReserved>snap.limits.users||tenant.branchCount>snap.limits.branches){
      entries.push({slug:tenant.slug,result:'limits-exceeded'});continue;
    }
    if(apply){
      const session=await mongoose.startSession();
      try{await session.withTransaction(async()=>{
        const update=await Tenant.updateOne({_id:tenant._id,subscription:{$exists:false}},
          {$set:{subscription:{...snap,status:'trial',source:'new_tenant_trial',periodStart:start,periodEnd:end,generation:1},enabledModules:snap.modules}},{session});
        if(update.modifiedCount!==1)throw new Error('Tenant changed concurrently; retry migration');
        await PlatformAuditLog.create([{actorId:'system:migration',action:'subscription.legacy_trial_migrated',moduleKey:'billing',
          recordId:String(tenant._id),after:{planCode:doc.code,planVersion:doc.version,periodEnd:end}}],{session});
      });}finally{await session.endSession();}
    }
    entries.push({slug:tenant.slug,result:apply?'trial-migrated':'would-migrate-trial'});
  }
  console.log(JSON.stringify({event:'commercial-migration',apply,entries}));
  if(entries.some(e=>!['trial-migrated','would-migrate-trial'].includes(e.result)))process.exitCode=2;
}
main().catch(e=>{console.error('Commercial migration failed:',e.message);process.exitCode=1;}).finally(()=>mongoose.disconnect());
