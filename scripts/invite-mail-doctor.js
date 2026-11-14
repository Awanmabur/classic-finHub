#!/usr/bin/env node
'use strict';
// Read-only, redacted invite delivery diagnosis. Never print credentials, recipients, token URLs or payloads.
require('dotenv').config();
const mongoose=require('mongoose');
const Outbox=require('../src/platform/models/OutboxEvent');
const Heartbeat=require('../src/platform/models/WorkerHeartbeat');
const {connectWorkerMongo}=require('../src/config/workerMongo');
const envKeys=['MAIL_PROVIDER','MAIL_FROM','GMAIL_CLIENT_ID','GMAIL_CLIENT_SECRET','GMAIL_REFRESH_TOKEN','RESEND_API_KEY','INVITE_MAIL_ENCRYPTION_KEY_HEX'];
let stage='initialization';
async function main(){
 const mail=require('../src/config/mail');
 const invite=require('../src/config/inviteMail');
 const provider=String(process.env.MAIL_PROVIDER||'resend').toLowerCase();
 const config=Object.fromEntries(envKeys.map(key=>[key,Boolean(String(process.env[key]||'').trim())]));
 // Print presence only. Even sender address is not exposed.
 console.log(JSON.stringify({check:'worker_mail_configuration',provider,configured:mail.configured(),
  inviteReady:invite.configured(),present:config}));
 stage='database_connection';
 await connectWorkerMongo();
 try{
  stage='outbox_and_heartbeat_queries';
  const since=new Date(Date.now()-7*86400000);
  const [rows,active]=await Promise.all([
   Outbox.aggregate([{$match:{type:{$in:['tenant.owner.invited','tenant.staff.invited']},createdAt:{$gte:since}}},
    {$group:{_id:{type:'$type',state:'$state',failureCode:'$failureCode'},count:{$sum:1}}},
    {$sort:{'_id.type':1,'_id.state':1}}],
   ),
   Heartbeat.countDocuments({workerId:/^outbox-/,seenAt:{$gte:new Date(Date.now()-45000)}})
  ]);
  stage='summary';
  console.log(JSON.stringify({check:'outbox_seven_day_summary',activeWorkers:active,
   statusCounts:rows.map(row=>({type:row._id.type,state:row._id.state,
    failureCode:row._id.failureCode||null,count:row.count}))}));
 }finally{await mongoose.disconnect();}
}
main().catch(error=>{
 const knownCode=String(error?.code||'');
 console.error(JSON.stringify({check:'invitation_delivery',status:'diagnostic_failed',stage,errorType:error?.name||'Error',errorCode:/^[A-Z_0-9]{1,60}$/.test(knownCode)?knownCode:'unclassified'}));
 process.exitCode=1;
});
