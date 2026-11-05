#!/usr/bin/env node
'use strict';
// Exercises first publication on an empty, randomly named loopback-only database.
// This never deletes or rewrites the configured application's catalogue.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const env=require('../src/config/env');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const PlanVersion=require('../src/platform/models/PlanVersion');
const Audit=require('../src/platform/models/PlatformAuditLog');
const {plans}=require('../src/data/store');
const {publishCatalog}=require('../src/platform/services/commercial.service');

async function main(){
  if(env.nodeEnv==='production')throw new Error('Catalogue integration is prohibited in production');
  const uri=new URL(env.mongoPlatformUri);
  if(uri.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(uri.hostname)||
    uri.host.includes(',')||uri.username||uri.password)throw new Error('Catalogue integration requires an unauthenticated single-host loopback replica set');
  const database=`classicfin_catalog_probe_${crypto.randomBytes(8).toString('hex')}`;
  await mongoose.connect(env.mongoPlatformUri,{dbName:database,serverSelectionTimeoutMS:6000,autoIndex:false});
  try{
    verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1,maxTimeMS:2000}));
    await Promise.all([PlanVersion.createIndexes(),Audit.createIndexes()]);
    assert.equal(await PlanVersion.countDocuments(),0);
    // Fail after real plan writes, proving the enclosing transaction rolls back.
    const failingModel={
      findOne:filter=>PlanVersion.findOne(filter),
      create:async(documents,options)=>{
        await PlanVersion.create(documents,options);
        throw new Error('Deliberate catalogue transaction rollback');
      }
    };
    await assert.rejects(publishCatalog({apply:true,Model:failingModel}),/Deliberate catalogue transaction rollback/);
    assert.equal(await PlanVersion.countDocuments(),0,'failed publication must not leave partial plans');
    assert.equal(await Audit.countDocuments(),0,'failed publication must not leave a publication audit');
    const published=await publishCatalog({apply:true});
    assert.equal(published.length,plans.length);
    assert(published.every(p=>p.state==='published'));
    assert.equal(await PlanVersion.countDocuments({status:'published'}),plans.length);
    const event=await Audit.findOne({action:'catalog.initial_published'}).lean();
    assert.equal(event.after.plans.length,plans.length,'all published plans belong to the same audited transaction');
    const repeated=await publishCatalog({apply:true});
    assert(repeated.every(p=>p.state==='already-published'));
    assert.equal(await PlanVersion.countDocuments(),plans.length);
    assert.equal(await Audit.countDocuments({action:'catalog.initial_published'}),1,'repeat setup must not republish');
    // A scratch-only conflict must fail before any published revision is changed.
    // Bypass immutable model guards only to simulate pre-existing corrupt data
    // in this disposable database. Application updates cannot rewrite this field.
    await PlanVersion.collection.updateOne({code:plans[0].code},{$set:{sourceHash:'0'.repeat(64)}});
    await assert.rejects(publishCatalog({apply:true}),e=>e.status===409);
    assert.equal(await PlanVersion.countDocuments(),plans.length);
    assert.equal(await Audit.countDocuments({action:'catalog.initial_published'}),1);
    console.log('PASS: empty catalogue publication, atomic rollback, complete audit, repeatability and immutable-version conflict (local scratch only)');
  }finally{
    if(mongoose.connection.name!==database||!/^classicfin_catalog_probe_[a-f0-9]{16}$/.test(database))throw new Error('Unsafe catalogue scratch cleanup target');
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
}
main().catch(async e=>{console.error('Catalogue integration FAILED:',e.stack||e.message);process.exitCode=1;await mongoose.disconnect().catch(()=>{});});
