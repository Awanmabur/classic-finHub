#!/usr/bin/env node
'use strict';
// Destructive scratch-only integration: real MongoDB transactional uniqueness,
// idempotency, and append-only settlement evidence, NEVER provider settlement.
require('dotenv').config();
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const configured=new URL(process.env.MONGO_PLATFORM_URI||
 'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||
 !['localhost','127.0.0.1','[::1]'].includes(configured.hostname)||
 configured.host.includes(',')||configured.username||configured.password)
 throw Error('Linked settlement integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(5).toString('hex'),slug='fx-'+nonce;
configured.pathname='/cfh_linked_probe_'+nonce;
process.env.MONGO_PLATFORM_URI=configured.toString();
process.env.NODE_ENV='test';
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {models,ensure}=require('../src/tenant/settlements/models');
const id=()=>new mongoose.Types.ObjectId();
const hex=crypto.randomBytes(32).toString('hex');
const tenantId=id(),branchId=id(),sourceId=id(),maker=id(),reviewer=id(),
 walletId=id(),drawerId=id(),rateId=id();
let conn;
async function main(){
 await connectPlatformMongo();
 const hello=await mongoose.connection.db.admin().command({hello:1});
 if(!hello.setName||!hello.isWritablePrimary)throw Error('A real scratch replica-set primary is required');
 conn=getTenantConnection(slug);
 await ensure(conn);
 const Model=models(conn);
 const settlement={
  tenantId,branchId,sourceModule:'mobile_money',sourceId,
  sourceReference:'SCRATCH-LINK-'+nonce,idempotencyKey:crypto.randomUUID(),
  sourceFingerprint:hex,operation:'cash_out',providerCurrency:'UGX',
  cashCurrency:'SSP',providerPrincipalMinor:'100000',
  physicalCashMinor:'1300000',walletAccountId:walletId,cashAccountId:drawerId,
  rateSnapshot:{rateId,side:'buy',fromCurrency:'UGX',toCurrency:'SSP',
   rateDecimal:'130',approvedBy:reviewer,expiresAt:new Date('2030-01-01')},
  postingBatchIds:[id()],status:'posted',providerState:'unverified',
  occurredAt:new Date(),postedAt:new Date(),createdBy:maker
 };
 const txn=await conn.startSession();
 let created;
 try{
  await txn.withTransaction(async()=>{
   [created]=await Model.settlement.create([settlement],{session:txn});
   await Model.event.create([{
    tenantId,settlementId:created._id,branchId,stage:'cash_paid',
    evidenceSource:'internal_journal',evidenceDigest:crypto.randomBytes(32).toString('hex'),
    observedAt:new Date(),recordedBy:maker
   }],{session:txn});
  });
 }finally{await txn.endSession();}
 assert(created?._id,'An authentic MongoDB transaction must persist a settlement ID');
 const find=await Model.settlement.findById(created._id).lean();
 assert.equal(find?.status,'posted');
 assert.equal(find.providerState,'unverified');
 const evidence=await Model.event.findOne({settlementId:created._id,stage:'cash_paid'}).lean();
 assert(evidence,'An append-only source event must exist');
 await assert.rejects(Model.settlement.create({...settlement,_id:id()}),error=>error.code===11000);
 await assert.rejects(Model.settlement.create({...settlement,_id:id(),sourceId:id(),
  idempotencyKey:settlement.idempotencyKey}),error=>error.code===11000);
 await assert.rejects(Model.event.create({
  tenantId,settlementId:created._id,branchId,stage:'cash_paid',
  evidenceSource:'cash_count',evidenceDigest:crypto.randomBytes(32).toString('hex'),
  observedAt:new Date(),recordedBy:reviewer
 }),error=>error.code===11000);
 await assert.rejects(Model.event.updateOne({_id:evidence._id},{$set:{stage:'reversed'}}),
  /Settlement evidence is append-only/);
 await assert.rejects(Model.event.deleteOne({_id:evidence._id}),
  /Settlement evidence is append-only/);
 const after=await Model.event.find({_id:evidence._id}).lean();
 assert.equal(after.length,1);
 assert.equal(after[0].stage,'cash_paid');
 // Concurrent valid copies must fail at the DB uniqueness boundary, not merely
 // at controller validation or a sequential in-memory prior check.
 const second=crypto.randomUUID(),source2=id();
 const attempts=await Promise.allSettled([
  Model.settlement.create({...settlement,_id:id(),sourceId:source2,idempotencyKey:second}),
  Model.settlement.create({...settlement,_id:id(),sourceId:source2,idempotencyKey:second})
 ]);
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(attempts.filter(r=>r.status==='rejected'&&r.reason?.code===11000).length,1);
 console.log('PASS: linked settlement, evidence, unique source/reference and concurrent retries in real scratch MongoDB');
}
main().catch(error=>{console.error('SCRATCH INTEGRATION FAILED:',error.message);process.exitCode=1;})
 .finally(async()=>{
  if(conn){
   try{await conn.dropDatabase();}catch(error){console.error('Scratch cleanup failed:',error.message);process.exitCode=1;}
  }
  await mongoose.disconnect().catch(()=>{});
 });
