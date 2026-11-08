#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose=require('mongoose');
async function main(){const uri=process.env.MONGO_BACKUP_WORKER_URI;if(!uri)throw Error('Missing backup worker database');require('../src/config/mongoUris').parseMongoUri(uri,'Tenant backup worker URI');await mongoose.connect(uri,{autoIndex:false,maxPoolSize:1,serverSelectionTimeoutMS:4000});const count=await mongoose.connection.db.collection('workerheartbeats').countDocuments({workerId:/^tenant-backup-/,seenAt:{$gte:new Date(Date.now()-60000)}});if(!count)throw Error('No recent backup worker heartbeat');console.log('Tenant backup worker heartbeat ready');}
main().catch(()=>{console.error('Tenant backup worker heartbeat unavailable');process.exitCode=1;}).finally(()=>mongoose.disconnect());
