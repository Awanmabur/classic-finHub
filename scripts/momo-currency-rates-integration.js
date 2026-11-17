#!/usr/bin/env node
'use strict';
// Real disposable Mongo replica-set test; NEVER targets production.
const crypto=require('node:crypto'),assert=require('node:assert/strict');
require('dotenv').config();
const input=process.env.MONGO_PLATFORM_URI||
 'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true';
const url=new URL(input);
if(process.env.NODE_ENV==='production'||url.protocol!=='mongodb:'||
 !['localhost','127.0.0.1','[::1]'].includes(url.hostname)||
 url.host.includes(',')||url.username||url.password)
 throw Error('Currency-rate governance integration must use an anonymous localhost scratch replica set');
const nonce=crypto.randomBytes(7).toString('hex');
const slug='momo-rate-'+nonce;
url.pathname='/cfh_momo_rate_probe_'+nonce;
process.env.MONGO_PLATFORM_URI=url.toString();
process.env.NODE_ENV='test';
const mongoose=require('mongoose');
const Tenant=require('../src/platform/models/Tenant');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const {tenantDbNameFromSlug}=require('../src/config/tenantDatabaseName');
const core=require('../src/tenant/models');
const {permissionsFor}=require('../src/config/roles');
const rates=require('../src/tenant/settlements/mobileMoneyRates.service');
const rateBook=require('../src/tenant/settlements/rateBook');
let conn,tenant;
async function main(){
 await connectPlatformMongo();
 const hello=await mongoose.connection.db.admin().command({hello:1});
 if(!hello.setName||!hello.isWritablePrimary)throw Error('A real writable scratch replica-set primary is required');
 await Tenant.createIndexes();
 conn=getTenantConnection(slug);
 await core.ensureTenantIndexes(conn);
 const user=await core.tenantUserModel(conn).create({
  name:'Independent Rate Reviewer',email:'review-'+nonce+'@example.invalid',
  passwordHash:'scratch-only',role:'Tenant Owner',allowedModules:['mobile_money']});
 const branch=await core.branchModel(conn).create({
  name:'Cash Settlement Scratch',code:'rate'+nonce.slice(0,4),currency:'SSP',
  currencies:['SSP','KES','UGX'],createdBy:user._id,updatedBy:user._id
 });
 const cashier=await core.tenantUserModel(conn).create({
  name:'Cashier Rate Maker',email:'cashier-'+nonce+'@example.invalid',
  passwordHash:'scratch-only',role:'Mobile Money Operator',
  branchId:String(branch._id),allowedModules:['mobile_money']});
 const plan=require('../src/data/store').plans.find(p=>p.code==='agent');
 const commercial=require('../src/platform/services/commercial.service');
 const snapshot=commercial.planSnapshot({...commercial.asPlanVersion(plan),status:'published'});
 assert(snapshot.modules.includes('mobile_money'),'Scratch test needs a Mobile Money plan');
 const now=Date.now();
 tenant=await Tenant.create({
  name:'Mobile Money Rate Scratch',slug,dbName:tenantDbNameFromSlug(slug),
  owner:user.name,email:user.email,plan:'agent',status:'active',setupStatus:'complete',
  seatsReserved:2,branchCount:1,enabledModules:snapshot.modules.filter(m=>m!=='forex'),
  subscription:{...snapshot,modules:snapshot.modules.filter(m=>m!=='forex'),
   status:'granted',source:'manual_admin_grant',generation:1,
   periodStart:new Date(now-3600000),periodEnd:new Date(now+86400000)}
 });
 const owner={id:String(user._id),role:'Tenant Owner',authVersion:0,branchId:null,
  permissions:permissionsFor('Tenant Owner'),allowedModules:['mobile_money']};
 const maker={id:String(cashier._id),role:'Mobile Money Operator',authVersion:0,
  branchId:String(branch._id),permissions:permissionsFor('Mobile Money Operator'),allowedModules:['mobile_money']};
 assert(!tenant.enabledModules.includes('forex'),'No standalone Forex entitlement may be required');
 const inputRate={fromCurrency:'KES',toCurrency:'SSP',side:'buy',
  rateDecimal:'13.50',validHours:'24',
  note:'Actual counted cash conversion agreed for scratch test'};
 const proposed=await rates.propose(conn,tenant,maker,branch._id,inputRate);
 assert.equal(proposed.status,'pending_review');
 await assert.rejects(rates.review(conn,tenant,maker,branch._id,proposed._id,
  {decision:'approve',note:'Self approval must never proceed'}),error=>error.status===403);
 const approved=await rates.review(conn,tenant,owner,branch._id,proposed._id,
  {decision:'approve',note:'Independent counted price and agreed evidence'});
 assert.equal(approved.status,'active');
 assert.equal(String(approved.reviewedBy),owner.id);
 const found=await rateBook.loadApprovedRate(conn,null,{
  tenant,rateId:String(approved._id),branchId:String(branch._id),
  fromCurrency:'KES',toCurrency:'SSP',side:'buy'});
 assert.equal(found.snapshot.rateDecimal,'13.50');
 await assert.rejects(rates.review(conn,tenant,owner,branch._id,proposed._id,
  {decision:'approve',note:'Cannot approve same rate twice'}),error=>error.status===409);
 const next=await rates.propose(conn,tenant,maker,branch._id,{...inputRate,rateDecimal:'13.00'});
 const revised=await rates.review(conn,tenant,owner,branch._id,next._id,
  {decision:'approve',note:'Updated independently verified cash price'});
 assert.equal(revised.status,'active');
 const prior=await core.forexRateModel(conn).findById(proposed._id).lean();
 assert.equal(prior.status,'superseded');
 const events=await core.auditEventModel(conn).find({targetId:{$in:[proposed._id,next._id]}}).lean();
 assert(events.some(e=>e.action==='forex.rate.proposed'));
 assert(events.some(e=>e.action==='forex.rate.approved'));
 console.log('PASS: no-Forex-subscription Mobile Money KES/SSP rates proposed, independently approved, rechecked, superseded and audited in a real replica set.');
}
main().catch(error=>{console.error('MOMO RATE INTEGRATION FAILED:',error.message);process.exitCode=1;})
 .finally(async()=>{
  if(conn)try{await conn.dropDatabase();}catch(error){console.error('Tenant scratch cleanup failed:',error.message);process.exitCode=1;}
  try{await mongoose.connection.dropDatabase();}catch(error){console.error('Platform scratch cleanup failed:',error.message);process.exitCode=1;}
  await mongoose.disconnect().catch(()=>{});
 });