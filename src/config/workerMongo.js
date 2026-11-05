'use strict';
const mongoose=require('mongoose');
function workerUri(env=process.env){
  if(env.NODE_ENV==='production'&&!env.MONGO_WORKER_URI)
    throw new Error('Production outbox worker requires its own least-privilege MONGO_WORKER_URI');
  const uri=env.MONGO_WORKER_URI||env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true';
  const parsed=new URL(uri);
  if(!['mongodb:','mongodb+srv:'].includes(parsed.protocol)||!parsed.pathname||parsed.pathname==='/')
    throw new Error('Worker MongoDB URI must explicitly name the platform database');
  return uri;
}
async function connectWorkerMongo(){
  mongoose.set('strictQuery',true);
  return mongoose.connect(workerUri(),{serverSelectionTimeoutMS:7000,maxPoolSize:5,autoIndex:false,retryWrites:true});
}
module.exports={workerUri,connectWorkerMongo};
