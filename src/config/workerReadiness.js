'use strict';
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const freshnessMs=Object.freeze({outbox:45000,notification:45000,'tenant-backup':60000});

function workerMarker(kind,directory){
 if(!Object.hasOwn(freshnessMs,kind))throw new Error('Unknown worker class');
 return path.join(directory,'classicfin-'+kind+'-instance');
}

// Each production worker runs in a separate container with a private /tmp.
// Its health command must check the ID created by that process at startup.
async function publishWorkerId(kind,id,{directory=os.tmpdir()}={}){
 await fs.writeFile(workerMarker(kind,directory),id,{mode:0o600});
}

async function workerFilter(kind,{instance=false,directory=os.tmpdir(),now=Date.now()}={}){
 const filename=workerMarker(kind,directory);
 let workerId=new RegExp('^'+kind+'-');
 if(instance){
  workerId=(await fs.readFile(filename,'utf8')).trim();
  if(!new RegExp('^'+kind+'-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$').test(workerId)){
   throw new Error('Invalid local worker identity');
  }
 }
 return {workerId,seenAt:{$gte:new Date(now-freshnessMs[kind])}};
}

module.exports={publishWorkerId,workerFilter};
