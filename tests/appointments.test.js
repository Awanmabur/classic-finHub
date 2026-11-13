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
  csrfToken:'csrf-proof',data:{appointment,moduleLabels:{banking:'Banking'}}
 });
 assert(preview.includes('&lt;script&gt;bad&lt;/script&gt;'));
 assert(!preview.includes('<script>bad'));
 assert.match(preview,/name="_csrf" value="csrf-proof"/);
 assert.match(preview,/appointments\/507f1f77bcf86cd799439012\/decision/);
 assert.match(preview,/name="revision" value="0"/);
 assert.match(preview,/name="action" value="confirm"/);
 assert.match(preview,/name="action" value="cancel"/);
});
