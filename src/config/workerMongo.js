'use strict';
const mongoose=require('mongoose');
const {platformUri,parseMongoUri}=require('./mongoUris');
function workerUri(env=process.env){
  if(env.NODE_ENV==='production'&&!env.MONGO_WORKER_URI)
    throw new Error('Production outbox worker requires its own least-privilege MONGO_WORKER_URI');
  const uri=env.MONGO_WORKER_URI||(env.MONGO_PLATFORM_URI||env.PLATFORM_DB_URI?platformUri(env):'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
  parseMongoUri(uri,'Worker MongoDB URI');
  return uri;
}
async function connectWorkerMongo(){
  mongoose.set('strictQuery',true);
  return mongoose.connect(workerUri(),{serverSelectionTimeoutMS:7000,maxPoolSize:5,autoIndex:false,retryWrites:true});
}
module.exports={workerUri,connectWorkerMongo};
