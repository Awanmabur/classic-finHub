'use strict';
const mongoose=require('mongoose');
const Appointment=require('../models/Appointment');
const Admin=require('../models/PlatformAdmin');
const Audit=require('../models/PlatformAuditLog');
const STATUSES=['pending','confirmed','completed','cancelled'];
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function id(value){if(typeof value!=='string'||!/^[a-f0-9]{24}$/i.test(value))throw fail('Appointment not found',404);return value;}
function normalize(input,now=new Date()){
 if(!['confirm','complete','cancel'].includes(input.action))throw fail('Choose a valid appointment action');
 if(!/^(?:0|[1-9]\d{0,8})$/.test(String(input.revision??'')))throw fail('Reload the appointment before saving');
 if(typeof input.note!=='string'||input.note.trim().length<12||input.note.trim().length>400||/[\u0000-\u001f\u007f]/.test(input.note))throw fail('Explain the decision in 12–400 characters');
 const result={action:input.action,revision:Number(input.revision),note:input.note.trim()};
 if(result.action==='confirm'){
  const raw=input.scheduledAt;
  if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}\.\d{3}Z)?$/.test(raw))throw fail('Choose the scheduled date and time in UTC');
  const at=new Date(raw.length===16?raw+':00.000Z':raw);
  if(!Number.isFinite(at.valueOf())||at.toISOString().slice(0,16)!==raw.slice(0,16)||at<new Date(now.valueOf()-300000)||at>new Date(now.valueOf()+366*86400000))throw fail('Choose a valid future appointment within one year');
  const link=input.meetingLink||'';if(typeof link!=='string'||link.length>500)throw fail('Enter a valid HTTPS meeting link');
  if(link){let url;try{url=new URL(link);}catch{throw fail('Enter a valid HTTPS meeting link');}if(url.protocol!=='https:'||url.username||url.password||/[\u0000-\u0020\u007f]/.test(link))throw fail('Enter a valid HTTPS meeting link');}
  Object.assign(result,{scheduledAt:at,meetingLink:link});
 }
 return result;
}
async function list(input={}){
 const filter={};if(input.status){if(typeof input.status!=='string'||!STATUSES.includes(input.status))throw fail('Choose a valid appointment status');filter.status=input.status;}
 if(input.cursor)filter._id={$lt:new mongoose.Types.ObjectId(id(input.cursor))};
 if(input.q){if(typeof input.q!=='string'||input.q.length>80)throw fail('Use a shorter appointment search');const escaped=input.q.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');if(escaped)filter.$or=['businessName','contactName','email'].map(key=>({[key]:new RegExp('^'+escaped,'i')}));}
 const rows=await Appointment.find(filter).sort({_id:-1}).limit(51).maxTimeMS(5000).lean(),hasMore=rows.length>50,items=rows.slice(0,50);
 return {items:items.map(row=>({...row,modules:Array.isArray(row.modules)?row.modules.filter(key=>typeof key==='string'):[],status:row.status||'pending',revision:row.revision||0})),nextCursor:hasMore?String(items.at(-1)._id):null,filters:{status:input.status||'',q:input.q||''}};
}
async function decide(appointmentId,actor,input,{now=new Date()}={}){
 if(!actor?.permissions?.includes('*')||!actor.id)throw fail('Platform administrator required',403);
 const appointment=id(appointmentId),value=normalize(input,now),session=await mongoose.startSession();let result;
 try{await session.withTransaction(async()=>{
  const admin=await Admin.findOneAndUpdate({_id:id(String(actor.id)),status:'active',role:'Super Admin',authVersion:actor.authVersion||0,mfaEnabledAt:{$ne:null}},{$inc:{__v:1}},{new:true,session}).lean();
  if(!admin)throw fail('Administrator access changed. Sign in again before saving.',403);
  const prior=await Appointment.findById(appointment).session(session).lean();if(!prior)throw fail('Appointment not found',404);
  const status=prior.status||'pending';if(['completed','cancelled'].includes(status))throw fail('This appointment is already closed',409);
  if(value.action==='complete'&&(status!=='confirmed'||!prior.scheduledAt||new Date(prior.scheduledAt)>now))throw fail('Only a confirmed appointment that has started can be completed',409);
  const next=value.action==='confirm'?'confirmed':value.action==='complete'?'completed':'cancelled';
  const changes={status:next,reviewNote:value.note,...(value.action==='confirm'?{scheduledAt:value.scheduledAt,meetingLink:value.meetingLink}:{})};
  result=await Appointment.findOneAndUpdate({_id:appointment,revision:value.revision===0?{$in:[0,null]}:value.revision},{$set:changes,$inc:{revision:1},$push:{decisions:{action:value.action,from:status,to:next,note:value.note,scheduledAt:value.scheduledAt||prior.scheduledAt,meetingLink:value.meetingLink??prior.meetingLink??'',actorId:admin._id,at:now}}},{new:true,session,runValidators:true}).lean();
  if(!result)throw fail('The appointment changed. Reload before saving.',409);
  await Audit.create([{actorId:String(admin._id),actorName:admin.name,action:'appointment.'+value.action,moduleKey:'appointments',recordId:appointment,before:{status,scheduledAt:prior.scheduledAt||null},after:{...changes,note:value.note}}],{session});
 });return result;}finally{await session.endSession();}
}
module.exports={list,decide,normalize,STATUSES};
