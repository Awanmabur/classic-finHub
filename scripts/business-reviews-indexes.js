#!/usr/bin/env node
'use strict';
// Additive schema migration only: creates the new review collection's indexes.
// Never writes or modifies tenant records, cash/float ledgers or customer accounts.
const mongoose=require('mongoose');
const {connectPlatformMongo}=require('../src/config/mongo');
const BusinessReview=require('../src/platform/models/BusinessReview');
async function main(){
 await connectPlatformMongo();
 try{
  const hello=await mongoose.connection.db.admin().command({hello:1,maxTimeMS:3500});
  if(!hello.setName||!hello.isWritablePrimary)throw Error('Replica set primary required for review indexes');
  await BusinessReview.createIndexes();
  const names=(await BusinessReview.listIndexes()).map(index=>index.name);
  if(!names.includes('tenantSlug_1_tokenHash_1'))throw Error('Review edit token uniqueness index absent');
  console.log(JSON.stringify({event:'business_review_indexes_verified',indexCount:names.length,
    tokenUniqueness:true}));
 }finally{await mongoose.disconnect();}
}
main().catch(error=>{console.error('Review index verification failed:',error.code||error.message);process.exitCode=1;});
