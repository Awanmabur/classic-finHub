'use strict';
// Public tenant branding ONLY. Never use this bucket for identity documents,
// financial statements, database backups or any private workspace file.
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const workspace=require('./service');
const {auditEventModel}=require('../models');
const MAX_BYTES=3*1024*1024,MAX_PIXELS=16_000_000;
const KINDS=Object.freeze({logo:'logo',cover:'cover',gallery:'gallery'});
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function config(){
 const p=process.env,account=p.R2_MEDIA_ACCOUNT_ID,access=p.R2_MEDIA_ACCESS_KEY_ID,
  secret=p.R2_MEDIA_SECRET_ACCESS_KEY,bucket=p.R2_MEDIA_BUCKET,publicUrl=p.R2_MEDIA_PUBLIC_URL;
 if(!/^[a-f0-9]{32}$/i.test(account||'')||!access||!secret||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket||''))
  throw fail('Public R2 image storage has not been configured by the platform operator.',503);
 let url;try{url=new URL(publicUrl);}catch{}
 if(!url||url.protocol!=='https:'||!url.hostname||url.username||url.password||url.search||url.hash||url.pathname!=='/')
  throw fail('The R2 public media domain has not been configured.',503);
 return {account,access,secret,bucket,base:url.href.replace(/\/+$/,'')};
}
function configured(){try{config();return true;}catch{return false;}}
const schema=new mongoose.Schema({
 tenantId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 kind:{type:String,enum:Object.keys(KINDS),required:true,immutable:true},
 key:{type:String,required:true,immutable:true,maxlength:260},
 url:{type:String,required:true,immutable:true,maxlength:500},
 mime:{type:String,required:true,enum:['image/png','image/jpeg','image/webp'],immutable:true},
 bytes:{type:Number,required:true,min:1,max:MAX_BYTES,immutable:true},
 sha256:{type:String,required:true,match:/^[a-f0-9]{64}$/,immutable:true},
 createdBy:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 status:{type:String,enum:['active','deleting'],default:'active'},
 referenceRevision:{type:Number,default:0,min:0}
},{timestamps:true,strict:'throw'});
schema.index({tenantId:1,createdAt:-1});
schema.index({key:1},{unique:true});
function model(conn){return conn.models.TenantWorkspaceMediaV1||conn.model('TenantWorkspaceMediaV1',schema);}
const indexPromises=new WeakMap();
async function ensureMediaIndexes(conn){
 if(!indexPromises.has(conn)){
  const task=ensureModelIndexes(model(conn)).catch(error=>{indexPromises.delete(conn);throw error;});
  indexPromises.set(conn,task);
 }
 await indexPromises.get(conn);
}
function objectId(value){
 if(!/^[a-f0-9]{24}$/i.test(String(value||'')))throw fail('Invalid public image identifier.');
 return new mongoose.Types.ObjectId(value);
}
function validateImage(buffer,mime){
 if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>MAX_BYTES)
  throw fail('Choose an image smaller than 3 MB.',413);
 if(!['image/jpeg','image/png','image/webp'].includes(mime))
  throw fail('Only JPEG, PNG and WebP public images can be uploaded.',415);
 let width=0,height=0,clean=buffer;
 if(mime==='image/png'){
  if(buffer.length<45||buffer.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||buffer.toString('ascii',12,16)!=='IHDR')
   throw fail('Invalid PNG image.',415);
  width=buffer.readUInt32BE(16);height=buffer.readUInt32BE(20);
  const chunks=[buffer.subarray(0,8)];let off=8,ended=false,animated=false;
  while(off+12<=buffer.length){
   const size=buffer.readUInt32BE(off),end=off+12+size;
   if(end>buffer.length||end<off)throw fail('Damaged PNG image.',415);
   const type=buffer.toString('ascii',off+4,off+8);
   if(type==='acTL')animated=true;
   if(!['tEXt','zTXt','iTXt','eXIf'].includes(type))chunks.push(buffer.subarray(off,end));
   off=end;
   if(type==='IEND'){ended=true;break;}
  }
  if(animated||!ended||off!==buffer.length)throw fail('Use a normal non-animated PNG image.',415);
  clean=Buffer.concat(chunks);
 }else if(mime==='image/jpeg'){
  if(buffer.length<32||buffer[0]!==0xff||buffer[1]!==0xd8||
     buffer[buffer.length-2]!==0xff||buffer[buffer.length-1]!==0xd9)
   throw fail('Invalid JPEG image.',415);
  const chunks=[buffer.subarray(0,2)];let i=2,scanned=false;
  while(i+4<buffer.length){
   const start=i;if(buffer[i++]!==0xff)throw fail('Damaged JPEG marker.',415);
   while(buffer[i]===0xff)i++;
   const marker=buffer[i++];
   if(marker===0xda){chunks.push(buffer.subarray(start));scanned=true;break;}
   if([0xd8,0xd9,0x00].includes(marker)||i+2>buffer.length)throw fail('Damaged JPEG header.',415);
   const size=buffer.readUInt16BE(i);
   if(size<2||i+size>buffer.length)throw fail('Damaged JPEG segment.',415);
   if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb].includes(marker)){
    if(size<7)throw fail('Invalid JPEG dimensions.',415);
    height=buffer.readUInt16BE(i+3);width=buffer.readUInt16BE(i+5);
   }
   // Strip EXIF/GPS, XMP, IPTC and JPEG comments before objects are public.
   if(![0xe1,0xed,0xfe].includes(marker))chunks.push(buffer.subarray(start,i+size));
   i+=size;
  }
  if(!scanned)throw fail('JPEG pixel data is missing.',415);
  clean=Buffer.concat(chunks);
 }else{
  if(buffer.length<30||buffer.toString('ascii',0,4)!=='RIFF'||buffer.toString('ascii',8,12)!=='WEBP'||
    buffer.readUInt32LE(4)+8!==buffer.length)throw fail('Invalid WebP image.',415);
  let off=12,found=false;
  while(off+8<=buffer.length){
   const type=buffer.toString('ascii',off,off+4),size=buffer.readUInt32LE(off+4),data=off+8;
   if(data+size>buffer.length)throw fail('Damaged WebP image.',415);
   // Reject metadata/animation rather than publishing hidden location data.
   if(['EXIF','XMP ','ICCP','ANIM','ANMF'].includes(type))throw fail('Remove metadata or animation before uploading WebP.',415);
   if(type==='VP8X'&&size>=10){
    const flags=buffer[data];
    if(flags&0x2e)throw fail('Unsupported WebP metadata or animation.',415);
    width=1+buffer.readUIntLE(data+4,3);height=1+buffer.readUIntLE(data+7,3);found=true;
   }else if(type==='VP8 '&&size>=10&&!found){
    if(buffer[data+3]===0x9d&&buffer[data+4]===0x01&&buffer[data+5]===0x2a){
     width=buffer.readUInt16LE(data+6)&0x3fff;height=buffer.readUInt16LE(data+8)&0x3fff;found=true;
    }
   }else if(type==='VP8L'&&size>=5&&!found&&buffer[data]===0x2f){
    width=1+(buffer[data+1]|((buffer[data+2]&0x3f)<<8));
    height=1+((buffer[data+2]>>6)|(buffer[data+3]<<2)|((buffer[data+4]&15)<<10));found=true;
   }
   off=data+size+(size&1);
  }
  if(off!==buffer.length)throw fail('Invalid WebP payload.',415);
 }
 if(!width||!height||width>6000||height>6000||width*height>MAX_PIXELS)
  throw fail('Image dimensions exceed the safe limit. Resize the image before uploading.',413);
 if(clean.length>MAX_BYTES)throw fail('The processed image exceeds 3 MB.',413);
 return {buffer:clean,width,height,mime,sha256:crypto.createHash('sha256').update(clean).digest('hex')};
}
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const hmac=(key,value,encoding)=>crypto.createHmac('sha256',key).update(value).digest(encoding);
function signature({method,key,mime,body,date=new Date(),settings=config()}){
 const stamp=date.toISOString().replace(/[:-]|\.\d{3}/g,''),day=stamp.slice(0,8),
  host=settings.account+'.r2.cloudflarestorage.com',uri='/'+settings.bucket+'/'+key;
 const hashed=sha(body||Buffer.alloc(0));
 const headers={host,'x-amz-date':stamp,'x-amz-content-sha256':hashed};
 if(mime){headers['content-type']=mime;headers['cache-control']='public, max-age=31536000, immutable';}
 const names=Object.keys(headers).sort(),signed=names.join(';');
 const canonical=method+'\n'+uri+'\n\n'+names.map(name=>name+':'+headers[name].trim()+'\n').join('')+'\n'+signed+'\n'+hashed;
 const scope=day+'/auto/s3/aws4_request';
 const stringToSign='AWS4-HMAC-SHA256\n'+stamp+'\n'+scope+'\n'+sha(canonical);
 const signingKey=hmac(hmac(hmac(hmac('AWS4'+settings.secret,day),'auto'),'s3'),'aws4_request');
 const sig=hmac(signingKey,stringToSign,'hex');
 return {url:'https://'+host+uri,
  headers:{...headers,Authorization:'AWS4-HMAC-SHA256 Credential='+settings.access+'/'+scope+', SignedHeaders='+signed+', Signature='+sig}};
}
async function storage(method,key,mime,body){
 const signed=signature({method,key,mime,body});
 let response;
 try{response=await fetch(signed.url,{method,headers:signed.headers,...(body?{body}:{}),
    signal:AbortSignal.timeout(15000)});}
 catch{throw fail('Public image storage is unreachable. Nothing was published.',503);}
 if(!response.ok){
  // Never expose the XML error response: R2 can return private configuration.
  throw fail('Public image storage rejected the request. Check private R2 bucket permissions.',503);
 }
 return response;
}
async function upload(conn,tenant,actor,kind,raw,mime){
 if(!Object.hasOwn(KINDS,kind))throw fail('Unknown public image category.',400);
 await workspace.access(conn,tenant,actor,{manage:true});
 const asset=validateImage(raw,mime),settings=config();
 const Media=model(conn);
 await ensureMediaIndexes(conn);
 if(await Media.countDocuments({tenantId:tenant._id,status:'active'}).maxTimeMS(3000)>=200)
  throw fail('Public media storage limit reached. Delete unused images before uploading more.',409);
 const mediaId=new mongoose.Types.ObjectId();
 const ext=mime==='image/png'?'png':mime==='image/jpeg'?'jpg':'webp';
 const key='tenants/'+tenant._id+'/public/'+kind+'/'+mediaId+'.'+ext;
 await storage('PUT',key,mime,asset.buffer);
 const url=settings.base+'/'+key;
 const session=await conn.startSession();
 try{
  await session.withTransaction(async()=>{
   const trusted=await workspace.access(conn,tenant,actor,{manage:true,session,fence:true});
   await Media.create([{_id:mediaId,tenantId:tenant._id,kind,key,url,mime,
     bytes:asset.buffer.length,sha256:asset.sha256,createdBy:trusted.actor.id}],{session});
   await auditEventModel(conn).create([{action:'workspace.public_media.uploaded',
     actorId:trusted.actor.id,targetId:mediaId,
     metadata:{tenantId:String(tenant._id),kind,bytes:asset.buffer.length}}],{session});
  });
 }catch(error){
  // A transaction commit can succeed while the acknowledgement is lost.
  // Never delete its object until the persisted record is conclusively absent.
  let persisted=null;
  try{persisted=await Media.findById(mediaId).lean();}
  catch{throw error;} // Ambiguous state: leave the object for recovery, never delete it.
  if(persisted)return {id:String(mediaId),url,kind,mime,width:asset.width,height:asset.height,bytes:asset.buffer.length};
  try{await storage('DELETE',key,null,null);}catch{console.error(JSON.stringify({event:'r2_orphan_cleanup_failed',mediaId:String(mediaId)}));}
  throw error;
 }finally{await session.endSession();}
 return {id:String(mediaId),url,kind,mime,width:asset.width,height:asset.height,bytes:asset.buffer.length};
}
async function list(conn,tenant,actor){
 await workspace.access(conn,tenant,actor);
 return model(conn).find({tenantId:tenant._id,status:{$in:['active','deleting']}})
  .select('_id kind url mime bytes status createdAt').sort({createdAt:-1}).limit(201).lean();
}
async function remove(conn,tenant,actor,mediaId){
 await workspace.access(conn,tenant,actor,{manage:true});
 const Media=model(conn),id=objectId(mediaId);
 const record=await Media.findOne({_id:id,tenantId:tenant._id,status:{$in:['active','deleting']}}).lean();
 if(!record)throw fail('This image is unavailable.',404);
 const Config=require('./models').models(conn).config;
 const used=details=>Boolean(details&&(details.logoUrl===record.url||details.coverUrl===record.url||
  (details.gallery||[]).includes(record.url)));
 const saved=await Config.findOne({tenantId:tenant._id}).select('landing.details landing.published.details').lean();
 if(used(saved?.landing?.details)||used(saved?.landing?.published?.details))
  throw fail('This image is used in your draft or published website. Replace and publish it before deleting.',409);
 const directory=await require('../../platform/models/Tenant').findById(tenant._id).select('directory.logoUrl directory.coverUrl').lean();
 if(directory?.directory?.logoUrl===record.url||directory?.directory?.coverUrl===record.url)
  throw fail('The public business directory still uses this image. Publish a replacement and let the directory update before deleting.',409);
 let claimed=false;
 if(record.status==='active'){
  const session=await conn.startSession();
  try{await session.withTransaction(async()=>{
   const trusted=await workspace.access(conn,tenant,actor,{manage:true,session,fence:true});
   // Updating the config and media records forces Mongo write conflicts with
   // any simultaneous save/publish that tries to attach this exact object.
   const current=await Config.findOneAndUpdate({tenantId:tenant._id},{$inc:{revision:1}},
    {session,new:true}).lean();
   if(used(current?.landing?.details)||used(current?.landing?.published?.details))
    throw fail('The image is now in use. Refresh and retry after replacing it.',409);
   const changed=await Media.updateOne({_id:id,tenantId:tenant._id,status:'active'},
    {$set:{status:'deleting'}},{session});
   if(changed.modifiedCount!==1)throw fail('Image is already being deleted. Refresh and retry.',409);
   await auditEventModel(conn).create([{action:'workspace.public_media.removal_requested',
    actorId:trusted.actor.id,targetId:id,metadata:{tenantId:String(tenant._id),kind:record.kind}}],{session});
  });claimed=true;}finally{await session.endSession();}
 }
 try{await storage('DELETE',record.key,null,null);}
 catch(error){
  if(claimed){
   try{await Media.updateOne({_id:id,tenantId:tenant._id,status:'deleting'},
     {$set:{status:'active'}});}catch{
    console.error(JSON.stringify({event:'r2_media_restore_pending',mediaId:String(id)}));
   }
  }
  throw error;
 }
 // A successful remote DELETE with a lost Mongo acknowledgement must stay
 // retryable: the "deleting" row remains visible until DB cleanup completes.
 const cleanup=await conn.startSession();
 try{await cleanup.withTransaction(async()=>{
  const trusted=await workspace.access(conn,tenant,actor,{manage:true,session:cleanup,fence:true});
  const result=await Media.deleteOne({_id:id,tenantId:tenant._id,status:'deleting'},{session:cleanup});
  if(result.deletedCount!==1)throw fail('Image cleanup was completed by another request. Reload your media library.',409);
  await auditEventModel(conn).create([{action:'workspace.public_media.deleted',
   actorId:trusted.actor.id,targetId:id,
   metadata:{tenantId:String(tenant._id),kind:record.kind,bytes:record.bytes}}],{session:cleanup});
 });}
 catch(error){
  if(error.status===409)throw error;
  throw fail('R2 deletion succeeded but database cleanup is pending. Reload and retry the same deletion.',503);
 }finally{await cleanup.endSession();}
 return {removed:true};
}
async function verifyReferences(conn,tenant,details,session=null){
 if(!details)return;
 const base=process.env.R2_MEDIA_PUBLIC_URL?.replace(/\/+$/,'');
 if(!base)return;
 const sources=[['logo',details.logoUrl],['cover',details.coverUrl],
  ...(details.gallery||[]).map(url=>['gallery',url])];
 for(const [kind,url] of sources){
  if(typeof url!=='string'||!url.startsWith(base+'/tenants/'))continue;
  // A write fence forces a conflict if another request tries to delete this
  // object while a draft/save or publish transaction attaches its URL.
  const query=model(conn).findOneAndUpdate({tenantId:tenant._id,kind,url,status:'active'},
   {$inc:{referenceRevision:1}},{new:true,session});
  const owned=await query.select('_id').lean();
  if(!owned)throw fail('An uploaded image does not belong to this active tenant media library. Choose one of your own images.',409);
 }
}
module.exports={configured,config,validateImage,signature,upload,list,remove,verifyReferences,model,MAX_BYTES};
