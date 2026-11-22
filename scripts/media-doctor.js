#!/usr/bin/env node
'use strict';
// Explicit, harmless test asset only. No private documents or customer data.
const crypto=require('node:crypto');
const media=require('../src/tenant/workspace/r2Media');
const sample=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y/9SxoAAAAASUVORK5CYII=','base64');
async function main(){
 let settings;
 try{settings=media.config();}
 catch(error){console.error('BLOCKED:',error.message);process.exitCode=2;return;}
 console.log('R2 configuration: PRESENT');
 console.log('Bucket:',settings.bucket);
 console.log('Public host:',new URL(settings.base).hostname);
 if(!process.argv.includes('--write-test')){
  console.log('No storage operation performed. Use --write-test to verify an upload, public read and deletion.');
  return;
 }
 const key='healthchecks/'+crypto.randomUUID()+'.png',url=settings.base+'/'+key;
 let uploaded=false;
 try{
  const put=media.signature({method:'PUT',key,mime:'image/png',body:sample,settings});
  const uploadedResponse=await fetch(put.url,{
   method:'PUT',headers:put.headers,body:sample,signal:AbortSignal.timeout(15000)});
  if(!uploadedResponse.ok)throw Error('S3 write HTTP '+uploadedResponse.status);
  uploaded=true;
  console.log('R2 write: PASS');
  // A separate public hostname is mandatory. Internal S3 success is insufficient.
  const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Public media GET HTTP '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(!crypto.timingSafeEqual(crypto.createHash('sha256').update(bytes).digest(),
      crypto.createHash('sha256').update(sample).digest()))
   throw Error('Public delivery bytes did not match the uploaded object');
  console.log('Public media GET and SHA-256: PASS');
 }finally{
  if(uploaded){
   const del=media.signature({method:'DELETE',key,mime:null,body:null,settings});
   try{
    const response=await fetch(del.url,{method:'DELETE',headers:del.headers,signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('Deletion returned HTTP '+response.status);
    console.log('R2 test-object deletion: PASS');
   }catch(error){console.error('Test-object cleanup needs attention:',error.message);process.exitCode=1;}
  }
 }
}
main().catch(error=>{console.error('R2 end-to-end check FAILED:',error.message);process.exitCode=1;});
