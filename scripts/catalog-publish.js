#!/usr/bin/env node
'use strict';
const mongoose=require('mongoose');
const {connectPlatformMongo}=require('../src/config/mongo');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const {publishCatalog,publishNextVersion}=require('../src/platform/services/commercial.service');
const fs=require('node:fs');
async function main(){
  await connectPlatformMongo();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
  await require('../src/platform/models/PlanVersion').createIndexes();
  const apply=process.argv.includes('--apply');
  const fileArg=process.argv.find(v=>v.startsWith('--file='));
  if(fileArg){
    const filename=fileArg.slice('--file='.length);
    const reason=process.argv.find(v=>v.startsWith('--reason='))?.slice('--reason='.length)||'';
    if(!filename)throw new Error('Supply --file=path/to/plan.json');
    const raw=JSON.parse(fs.readFileSync(filename,'utf8'));
    const result=await publishNextVersion(raw,reason,{apply});
    console.log(JSON.stringify({event:'catalog-next-version',result}));
  }else{
    const results=await publishCatalog({apply});
    console.log(JSON.stringify({event:'catalog-initial-publication',apply,results}));
  }
}
main().catch(e=>{console.error('Catalogue publication failed:',e.message);process.exitCode=1;}).finally(()=>mongoose.disconnect());
