#!/usr/bin/env node
'use strict';
// Proof of the actual MongoDB unique partial-index behavior during tariff
// replacement. Uses a random scratch database on an unauthenticated loopback
// replica set only; refuses Atlas, production, remote and credentialed URIs.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const uri=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||uri.protocol!=='mongodb:'||
 !['127.0.0.1','localhost','[::1]'].includes(uri.hostname)||
 uri.username||uri.password||uri.host.includes(','))
 throw Error('Tariff replacement test requires unauthenticated loopback MongoDB only.');
const dbName='cfh_tariff_swap_'+crypto.randomBytes(8).toString('hex');
uri.pathname='/'+dbName;
let connected=false;
async function main(){
 await mongoose.connect(uri.toString(),{serverSelectionTimeoutMS:8000});
 connected=true;
 const database=mongoose.connection.db;
 require('../src/config/mongoTopology').verifyReplicaPrimary(await database.admin().command({hello:1}));
 const c=database.collection('schedules');
 await database.createCollection('schedules');
 const scope={tenant:'A',branch:'B',network:'MTN',currency:'UGX',operation:'cash_in',kind:'agent_commission'};
 await c.createIndex({tenant:1,branch:1,network:1,currency:1,operation:1,kind:1},{
  unique:true,name:'one_approved_schedule',partialFilterExpression:{status:'approved'}});
 await c.insertMany([{...scope,version:1,status:'approved'},{...scope,version:2,status:'draft'}]);
 const session=await mongoose.startSession();
 try {
  await session.withTransaction(async()=>{
   const a=await c.updateOne({...scope,version:1,status:'approved'},{$set:{status:'retired'}},{session});
   assert.equal(a.modifiedCount,1);
   const b=await c.updateOne({...scope,version:2,status:'draft'},{$set:{status:'approved'}},{session});
   assert.equal(b.modifiedCount,1);
  });
 }finally{await session.endSession();}
 assert.equal(await c.countDocuments({...scope,status:'approved'}),1);
 assert.equal((await c.findOne({...scope,version:2})).status,'approved');
 console.log('PASS: MongoDB can retire and approve unique partial-index tariff versions atomically.');
}
main().catch(error=>{console.error('TARIFF REPLACEMENT INTEGRATION FAILURE: '+error.message);process.exitCode=1;})
.finally(async()=>{
 if(connected){
  if(!/^cfh_tariff_swap_[a-f0-9]{16}$/.test(dbName)||mongoose.connection.name!==dbName)throw Error('Unsafe scratch cleanup');
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
 }
});
