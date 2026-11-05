#!/usr/bin/env node
'use strict';
// Idempotent periodic sweep. Restricted to tenant DBs already registered in the
// platform; safe against repeated and concurrent workers through conditional DB writes.
const mongoose=require('mongoose');
const Tenant=require('../src/platform/models/Tenant');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const {run}=require('../src/jobs/transferExpiry.job');
(async()=>{
 try{
  await connectPlatformMongo();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1,maxTimeMS:2000}));
  const result=await run({tenants:Tenant.find({}).select('slug').lean().cursor(),connectionForTenant:getTenantConnection});
  console.log(JSON.stringify({event:'money-transfer-expiry',...result}));
 }catch(e){console.error(JSON.stringify({event:'money-transfer-expiry-failed',message:e.message}));process.exitCode=1;}
 finally{await mongoose.disconnect();}
})();
