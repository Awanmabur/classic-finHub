'use strict';
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const uri=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||uri.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(uri.hostname)||uri.username||uri.password||uri.host.includes(','))throw Error('Appointment integration requires isolated loopback Mongo');
const dbName='cfh_appointments_'+crypto.randomBytes(7).toString('hex');uri.pathname='/'+dbName;process.env.MONGO_PLATFORM_URI=uri.toString();process.env.NODE_ENV='test';
const mongoose=require('mongoose'),{connectPlatformMongo}=require('../src/config/mongo');
const Appointment=require('../src/platform/models/Appointment'),Admin=require('../src/platform/models/PlatformAdmin'),Audit=require('../src/platform/models/PlatformAuditLog'),service=require('../src/platform/services/appointment.service');
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Promise.all([Appointment.createIndexes(),Admin.createIndexes(),Audit.createIndexes()]);
 const admin=await Admin.create({name:'Appointment reviewer',email:'appointment@example.invalid',passwordHash:'isolated-only',role:'Super Admin',mfaEnabledAt:new Date()});
 const actor={id:String(admin._id),name:admin.name,permissions:['*'],authVersion:0},now=new Date(),future=new Date(now.valueOf()+3600000);
 const input={action:'confirm',revision:'0',scheduledAt:future.toISOString(),meetingLink:'https://meet.example.invalid/session',note:'Confirmed the requested onboarding session with the contact'};
 const row=await Appointment.create({businessName:'Appointment Probe',contactName:'Request Contact',email:'request@example.invalid',modules:['banking'],status:'pending'});
 await assert.rejects(service.decide(String(row._id),{...actor,permissions:[]},input),{status:403});
 await assert.rejects(service.decide(String(row._id),actor,{...input,meetingLink:'javascript:alert(1)'}),{status:400});
 await assert.rejects(service.decide(String(row._id),actor,{...input,action:'complete'}),{status:409});
 const confirmed=await service.decide(String(row._id),actor,input);assert.equal(confirmed.status,'confirmed');assert.equal(confirmed.revision,1);assert.equal(confirmed.decisions.length,1);
 await assert.rejects(service.decide(String(row._id),actor,input),{status:409});
 await assert.rejects(service.decide(String(row._id),actor,{action:'complete',revision:'1',note:'Attempted completion before the scheduled appointment begins'}),{status:409});
 const completed=await service.decide(String(row._id),actor,{action:'complete',revision:'1',note:'The scheduled onboarding meeting was completed with the contact'},{now:new Date(future.valueOf()+1000)});
 assert.equal(completed.status,'completed');assert.equal(completed.revision,2);assert.equal(completed.decisions.length,2);
 await assert.rejects(service.decide(String(row._id),actor,{action:'cancel',revision:'2',note:'Closed appointments must retain their final recorded outcome'}),{status:409});
 const cancelled=await Appointment.create({businessName:'Cancel Probe',status:'pending'});await service.decide(String(cancelled._id),actor,{action:'cancel',revision:'0',note:'The contact requested cancellation before scheduling the meeting'});
 const racing=await Appointment.create({businessName:'Concurrent Probe',status:'pending'});
 const race=await Promise.allSettled([service.decide(String(racing._id),actor,input),service.decide(String(racing._id),actor,input)]);assert.equal(race.filter(result=>result.status==='fulfilled').length,1);assert.equal((await Appointment.findById(racing._id)).revision,1);
 const rollback=await Appointment.create({businessName:'Rollback Probe',status:'pending'}),oldCreate=Audit.create;
 Audit.create=async()=>{throw Error('Injected audit failure');};try{await assert.rejects(service.decide(String(rollback._id),actor,input),/Injected audit failure/);}finally{Audit.create=oldCreate;}
 assert.equal((await Appointment.findById(rollback._id)).status,'pending');assert.equal((await Appointment.findById(rollback._id)).revision,0);
 await Admin.updateOne({_id:admin._id},{$inc:{authVersion:1}});await assert.rejects(service.decide(String(rollback._id),actor,input),{status:403});
 await Admin.updateOne({_id:admin._id},{$set:{authVersion:0,mfaEnabledAt:null}});await assert.rejects(service.decide(String(rollback._id),actor,input),{status:403});
 assert.equal(await Audit.countDocuments({moduleKey:'appointments'}),4);
 await Appointment.insertMany(Array.from({length:55},(_,i)=>({businessName:'Page '+i,status:'pending'})));
 const first=await service.list({status:'pending'}),second=await service.list({status:'pending',cursor:first.nextCursor});assert.equal(first.items.length,50);assert(first.nextCursor);assert(second.items.length>0);assert(!second.items.some(item=>first.items.some(other=>String(other._id)===String(item._id))));
 const search=await service.list({q:'Appointment Probe'});assert.equal(search.items.length,1);assert.equal(search.items[0].status,'completed');
 console.log('PASS: appointment scheduling/completion/cancellation, HTTPS/date validation, fresh MFA/admin authorization, optimistic concurrency, complete audit rollback, terminal states and bounded cursor/search.');
}
main().catch(error=>{console.error('APPOINTMENT INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(async()=>{if(mongoose.connection.readyState===1&&mongoose.connection.name===dbName&&/^cfh_appointments_[a-f0-9]{14}$/.test(dbName))await mongoose.connection.db.dropDatabase();await mongoose.disconnect();});
