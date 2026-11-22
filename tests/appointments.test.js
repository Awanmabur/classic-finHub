'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),ejs=require('ejs'),path=require('node:path');
const appointments=require('../src/platform/services/appointment.service');
test('appointment confirmation validates UTC dates, revisions and safe meeting URLs',()=>{
 const now=new Date('2026-11-07T08:00:00Z'),value={action:'confirm',revision:'0',scheduledAt:'2026-11-07T10:30',meetingLink:'https://meeting.example.invalid/a',note:'An audited appointment scheduling decision'};
 assert.equal(appointments.normalize(value,now).scheduledAt.toISOString(),'2026-11-07T10:30:00.000Z');
 for(const patch of [{revision:'-1'},{revision:['0','1']},{scheduledAt:'2026-02-30T10:30'},{scheduledAt:'2026-11-06T10:30'},{meetingLink:'javascript:alert(1)'},{meetingLink:'https://user:password@example.invalid'},{note:'short'}])assert.throws(()=>appointments.normalize({...value,...patch},now));
});
test('appointment directory escapes names, keeps cursor filters and links to protected preview',async()=>{
 const appointment={_id:'507f1f77bcf86cd799439012',businessName:'<script>bad</script>',contactName:'Contact',email:'test@example.invalid',modules:['banking'],status:'pending',revision:0,decisions:[]};
 const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/platform/appointments/index.ejs'),{
  csrfToken:'csrf-proof',data:{filters:{status:'pending',q:'probe'},nextCursor:'507f1f77bcf86cd799439011',moduleLabels:{banking:'Banking'},appointments:[appointment]}
 });
 assert(html.includes('&lt;script&gt;bad&lt;/script&gt;'));
 assert(!html.includes('<script>bad'));
 assert.match(html,/href="\/platform\/appointments\/507f1f77bcf86cd799439012"/);
 assert.doesNotMatch(html,/appointments\/507f1f77bcf86cd799439012\/decision/);
 assert.match(html,/Older requests/);
 assert.match(html,/status=pending/);
 assert.match(html,/q=probe/);
 const preview=await ejs.renderFile(path.resolve(__dirname,'../src/views/platform/appointments/show.ejs'),{
  csrfToken:'csrf-proof',data:{appointment,timeZone:'Africa/Kampala',scheduledLocalValue:'',scheduledDisplay:'Not scheduled',moduleLabels:{banking:'Banking'}}
 });
 assert(preview.includes('&lt;script&gt;bad&lt;/script&gt;'));
 assert(!preview.includes('<script>bad'));
 assert.match(preview,/name="_csrf" value="csrf-proof"/);
 assert.match(preview,/appointments\/507f1f77bcf86cd799439012\/decision/);
 assert.match(preview,/name="revision" value="0"/);
 assert.match(preview,/name="action" value="confirm"/);
 assert.match(preview,/name="action" value="cancel"/);
});

test('admin scheduling uses a verified timezone and translates wall time into UTC',()=>{
 const now=new Date('2026-11-22T07:00:00Z');
 const input={action:'confirm',revision:'0',scheduledAt:'2026-11-22T13:30',
  note:'Confirming the applicant workspace demonstration',meetingLink:''};
 assert.equal(appointments.normalize(input,now,{timeZone:'Africa/Kampala'}).scheduledAt.toISOString(),'2026-11-22T10:30:00.000Z');
 assert.equal(appointments.normalize({...input,scheduledAt:'2026-11-22T10:30:00.000Z'},now,{timeZone:'Africa/Kampala'}).scheduledAt.toISOString(),'2026-11-22T10:30:00.000Z');
 assert.throws(()=>appointments.normalize({...input,scheduledAt:'2026-03-08T02:30'},new Date('2026-03-07T06:00:00Z'),{timeZone:'America/New_York'}),{status:400},'DST skipped hour must not be booked');
 assert.equal(require('../src/utils/businessTime').dateTimeLocal(new Date('2026-11-22T10:30:00Z'),'Africa/Kampala'),'2026-11-22T13:30');
});
test('appointment form posts to real protected decision route without global background interception',()=>{
 const fs=require('node:fs'),root=require('node:path').resolve(__dirname,'..');
 const source=fs.readFileSync(root+'/src/platform/routes/index.js','utf8');
 const page=fs.readFileSync(root+'/src/views/platform/appointments/show.ejs','utf8');
 assert.match(source,/router\.post\('\/appointments\/:id\/decision'/);
 assert.match(page,/data-feedback-skip/);
 assert.match(page,/data\.scheduledLocalValue/);
});
