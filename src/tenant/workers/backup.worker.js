'use strict';
// Independent process. No web session secret, MFA key or SMS credentials.
require('dotenv').config();
const mongoose=require('mongoose'),Tenant=require('../../platform/models/Tenant'),WorkerHeartbeat=require('../../platform/models/WorkerHeartbeat'),{tenantDbNameFromSlug}=require('../../config/tenantDatabaseName'),service=require('../backups/service'),{models}=require('../backups/models');
const workerId='tenant-backup-'+require('node:crypto').randomUUID();let closing=false;
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{closing=true;});
async function beat(){await WorkerHeartbeat.updateOne({workerId},{$set:{seenAt:new Date(),expiresAt:new Date(Date.now()+180000)}},{upsert:true});}
async function sweep(){let processed=0,scanned=0;for await(const tenant of Tenant.find({status:{$in:['active','trial']}}).lean().cursor()){
 if(closing)break;if(++scanned>10000)throw Error('Backup tenant scan limit exceeded');await beat();const conn=mongoose.connection.useDb(tenantDbNameFromSlug(tenant.slug),{useCache:true});
 try{await service.schedule(conn,tenant);for(const policy of await models(conn).policy.find({requestedAt:{$ne:null}}).select('_id').limit(200).lean()){await beat();const result=await service.processPolicy(conn,tenant,policy._id);if(result){processed++;console.log(JSON.stringify({event:'tenant_backup.result',state:result.state,target:result.target||null}));}}}catch{console.error(JSON.stringify({event:'tenant_backup.tenant_error'}));}
 }return {processed,scanned};}
async function run(){const config=require('../backups/config').settings();if(!config.enabled)throw Error('Tenant backup service is disabled');const uri=process.env.MONGO_BACKUP_WORKER_URI;if(!uri)throw Error('MONGO_BACKUP_WORKER_URI is required');require('../../config/mongoUris').parseMongoUri(uri,'Tenant backup worker MongoDB URI');mongoose.set('strictQuery',true);await mongoose.connect(uri,{autoIndex:false,maxPoolSize:5,serverSelectionTimeoutMS:7000});require('../../config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));await WorkerHeartbeat.createIndexes();const heartbeat=setInterval(()=>beat().catch(()=>console.error(JSON.stringify({event:'tenant_backup.heartbeat_error'}))),15000);heartbeat.unref();while(!closing){await beat();await sweep().catch(()=>console.error(JSON.stringify({event:'tenant_backup.sweep_error'})));if(!closing)await new Promise(resolve=>setTimeout(resolve,30000));}clearInterval(heartbeat);await WorkerHeartbeat.deleteOne({workerId});await mongoose.disconnect();}
if(require.main===module)run().catch(()=>{console.error(JSON.stringify({event:'tenant_backup.start_failed'}));process.exitCode=1;mongoose.disconnect().catch(()=>{});});
module.exports={sweep,run};
