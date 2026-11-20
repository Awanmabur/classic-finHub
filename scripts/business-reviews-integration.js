#!/usr/bin/env node
'use strict';
// Scratch MongoDB test only. Fail closed before any production connection.
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const url=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||url.protocol!=='mongodb:'||
  !['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.host.includes(','))
  throw Error('Business review integration requires one unauthenticated loopback MongoDB replica set');
const nonce=crypto.randomBytes(7).toString('hex'),db='cfh_review_scratch_'+nonce;
url.pathname='/'+db;process.env.MONGO_PLATFORM_URI=url.toString();process.env.NODE_ENV='test';
process.env.SESSION_SECRET=crypto.randomBytes(48).toString('hex');
process.env.MFA_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');
const mongoose=require('mongoose'),session=require('express-session');
const {connectPlatformMongo,getTenantConnection,tenantDbNameFromSlug}=require('../src/config/mongo');
const Tenant=require('../src/platform/models/Tenant'),Review=require('../src/platform/models/BusinessReview');
const PlatformAuditLog=require('../src/platform/models/PlatformAuditLog');
const service=require('../src/platform/services/businessReviews.service');
const createApp=require('../src/app');
const slug='review-probe-'+nonce;
let server;
async function main(){
 await connectPlatformMongo();
 const hello=await mongoose.connection.db.admin().command({hello:1});
 assert(hello.setName,'Replica set required for moderated review audit transactions');
 try{
  await Promise.all([Tenant.createIndexes(),Review.createIndexes(),PlatformAuditLog.createIndexes(),
    require('../src/platform/models/LoginThrottle').createIndexes()]);
  const tenant=await Tenant.create({name:'Public test business',slug,dbName:tenantDbNameFromSlug(slug),
    email:'tenant@example.invalid',plan:'agent',status:'active',setupStatus:'complete',
    directoryListing:{visibility:'published',approvedAt:new Date()}});
  const app=createApp({sessionStore:new session.MemoryStore()});
  server=await new Promise(resolve=>{const http=app.listen(0,()=>resolve(http));});
  const base='http://127.0.0.1:'+server.address().port,cookies=new Map();
  const request=async(path,data)=>{
   const response=await fetch(base+path,{method:data?'POST':'GET',redirect:'manual',
    headers:{...(cookies.size?{cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')}:{}),
      ...(data?{'content-type':'application/x-www-form-urlencoded'}:{})},
    ...(data?{body:new URLSearchParams(data).toString()}:{})});
   for(const header of response.headers.getSetCookie?.()||[]){
    const first=header.split(';')[0],idx=first.indexOf('=');
    if(idx>0)cookies.set(first.slice(0,idx),first.slice(idx+1));
   }
   return {response,body:await response.text()};
  };
  let page=await request('/t/'+slug);
  assert.equal(page.response.status,200,page.body.slice(0,800));
  assert.match(page.response.headers.get('x-robots-tag')||'',/noindex/,'unpublished basic business has noindex');
  assert(!page.body.includes('name="_csrf"'),'A public business page must not generate a crawler session for reviewing');
  const compose=await request('/t/'+slug+'/review');
  assert.equal(compose.response.status,200,compose.body.slice(0,300));
  const token=compose.body.match(/name="_csrf" value="([a-f0-9]{64})"/)?.[1];
  assert(token,'CSRF token must be issued to anonymous customer on public business page');
  const csrf={_csrf:token};
  const result=await request('/t/'+slug+'/reviews',{...csrf,authorName:'Customer One',rating:'4',
    comment:'The service was professional and the team was courteous.',website:''});
  assert.equal(result.response.status,303,result.body.slice(0,150));
  let review=await Review.findOne({tenantId:tenant._id}).lean();
  assert(review&&review.status==='pending');
  page=await request('/t/'+slug);
  assert(!page.body.includes('The service was professional'),'Unmoderated feedback must never appear on public page');
  const mine=await request('/t/'+slug+'/my-review');
  assert.equal(mine.response.status,200,mine.body.slice(0,500));
  assert(mine.body.includes('Customer One'),'Customer editing token was not retained');
  const edited=await request('/t/'+slug+'/my-review',{...csrf,revision:'0',action:'edit',
    authorName:'Customer One',rating:'5',comment:'Updated review from the same original browser.'});
  assert.equal(edited.response.status,303,edited.body.slice(0,150));
  review=await Review.findOne({tenantId:tenant._id}).lean();
  assert.equal(review.revision,1);assert.equal(review.rating,5);assert.equal(review.status,'pending');
  const moderator={id:String(new mongoose.Types.ObjectId()),name:'Scratch moderator',permissions:['*']};
  await service.moderate(String(review._id),moderator,{action:'approve',revision:1,
    reason:'Specific customer feedback checked and approved for this scratch business.'});
  review=await Review.findOne({_id:review._id}).lean();
  assert.equal(review.status,'approved');
  page=await request('/t/'+slug);
  assert(page.body.includes('Updated review from the same original browser.'));
  assert(page.body.includes('5.0 / 5'));
  const after=await service.myReview(slug,{headers:{cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')}});
  assert.equal(after.revision,2);
  const withdrawn=await request('/t/'+slug+'/my-review',{...csrf,revision:'2',action:'withdraw'});
  assert.equal(withdrawn.response.status,303,withdrawn.body.slice(0,150));
  review=await Review.findOne({_id:review._id}).lean();
  assert.equal(review.status,'withdrawn');
  page=await request('/t/'+slug);
  assert(!page.body.includes('Updated review from the same original browser.'));
  assert.equal(await PlatformAuditLog.countDocuments({action:'business.review.moderated',recordId:String(review._id)}),1);
  console.log('PASS: customer submission, CSRF, private pending feedback, cookie-bound editing, audited approval, public stars, withdrawal and privacy.');
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  try{const conn=getTenantConnection(slug);assert.equal(conn.name,tenantDbNameFromSlug(slug));await conn.dropDatabase();}catch(error){console.error('Scratch tenant cleanup:',error.code||error.message);}
  await mongoose.connection.dropDatabase();await mongoose.disconnect();
 }
}
main().catch(error=>{console.error('BUSINESS REVIEW INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;});
