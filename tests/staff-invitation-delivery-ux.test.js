'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('staff directory displays outbox state without leaking invitation bearer tokens or provider mail secrets',()=>{
 const routes=read('src/tenant/routes/index.js');
 const view=read('src/views/tenant/users/index.ejs');
 const listing=routes.slice(routes.indexOf("router.get('/users'"),routes.indexOf("router.get('/users/:id/edit'"));
 assert.match(listing,/type:'tenant.staff.invited'/);
 assert.match(listing,/tenantId:req.tenant._id/);
 assert.match(listing,/\.select\('eventKey state failureCode providerAcceptance.acceptedAt'\)/);
 assert.doesNotMatch(listing,/encryptedUrl|tokenHash|GMAIL_REFRESH_TOKEN/);
 for(const label of ['Provider accepted','Delivery failed','Queued','Sending','Manual link'])assert.ok(view.includes(label),label);
});

test('safe invite business failures render actionable feedback while internal errors still use centralized handler',()=>{
 const routes=read('src/tenant/routes/index.js');
 const snippet=routes.slice(routes.indexOf("router.post('/users/invite'"),routes.indexOf("router.post('/users/:id/disable'"));
 assert.match(snippet,/\[400,403,409,422\]/);
 assert.match(snippet,/flash\(req,'bad',e.message\)/);
 assert.match(snippet,/next\(e\)/);
});

test('password recovery, invitation acceptance, and consistent visibility controls exist without weakening password fields',()=>{
 const publicRoutes=read('src/routes.public.js');
 for(const path of ['/forgot-password','/reset-password','/accept-staff-invite','/accept-invite'])assert(publicRoutes.includes(path),path);
 for(const file of ['src/views/original/reset-password.ejs','src/views/auth/accept-staff-invite.ejs','src/views/auth/accept-invite.ejs']){
  const html=read(file);
  assert.match(html,/data-password-toggle/);
  assert.match(html,/type="password"/);
  assert.match(html,/name="confirmPassword"/);
  assert.match(html,/aria-controls=/);
 }
 const script=read('public/js/password-visibility.js');
 assert.match(script,/input\.type=visible\?'text':'password'/);
 assert.match(script,/aria-pressed/);
 assert.doesNotThrow(()=>new Function(script));
 const login=read('src/views/original/signin.ejs');
 assert.match(login,/data-password-toggle/);
});

test('redacted invitation delivery doctor never prints recipients, tokens or actual credential values',()=>{
 const script=read('scripts/invite-mail-doctor.js');
 assert.match(script,/connectWorkerMongo/);
 assert.match(script,/Outbox\.aggregate/);
 assert.match(script,/Heartbeat\.countDocuments/);
 assert.doesNotMatch(script,/\.payload\.to|\.encryptedUrl|console\.log\(process\.env/);
 assert.doesNotThrow(()=>new Function(script));
});
