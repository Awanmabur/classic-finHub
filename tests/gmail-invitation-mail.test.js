'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mail=require('../src/config/mail');
const invites=require('../src/config/inviteMail');
const ENV_KEYS=['MAIL_PROVIDER','MAIL_FROM','GMAIL_CLIENT_ID','GMAIL_CLIENT_SECRET','GMAIL_REFRESH_TOKEN','INVITE_MAIL_ENCRYPTION_KEY_HEX','NODE_ENV'];
function env(values){
 const saved=Object.fromEntries(ENV_KEYS.map(k=>[k,process.env[k]]));
 for(const [k,v] of Object.entries(values))if(v===undefined)delete process.env[k];else process.env[k]=v;
 return ()=>{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;};
}
test('Gmail send uses OAuth refresh token and MIME base64URL with accepted message receipt',async()=>{
 const restore=env({MAIL_PROVIDER:'gmail',MAIL_FROM:'notify@example.com',GMAIL_CLIENT_ID:'oauth-client',
  GMAIL_CLIENT_SECRET:'oauth-secret',GMAIL_REFRESH_TOKEN:'oauth-refresh',NODE_ENV:'test'});
 const oldFetch=global.fetch;
 const seen=[];
 global.fetch=async(url,request)=>{
   seen.push({url,request});
   if(seen.length===1)return {ok:true,json:async()=>({access_token:'test-access',token_type:'Bearer'})};
   return {ok:true,json:async()=>({id:'gmail-message-001'})};
 };
 try{
   assert.equal(mail.configured(),true);
   const result=await mail.sendMail({to:'owner@example.com',subject:'Activate ClassicFin Hub',text:'Hello\nActivation link',idempotencyKey:'owner-invite-1'});
   assert.equal(result.provider,'gmail');assert.equal(result.messageId,'gmail-message-001');
   assert.equal(seen[0].url,'https://oauth2.googleapis.com/token');
   const params=new URLSearchParams(seen[0].request.body);
   assert.equal(params.get('grant_type'),'refresh_token');
   assert.equal(params.get('client_id'),'oauth-client');
   assert.equal(seen[1].url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
   const mime=Buffer.from(JSON.parse(seen[1].request.body).raw,'base64url').toString();
   assert.match(mime,/To: <owner@example.com>/);
   assert.match(mime,/Content-Transfer-Encoding: base64/);
   assert.match(mime,/Message-ID:/);
   assert.doesNotMatch(mime,/oauth-secret|oauth-refresh|test-access/);
 }finally{global.fetch=oldFetch;restore();}
});
test('invalid mail headers and unconfigured Gmail fail before any external call',async()=>{
 const restore=env({MAIL_PROVIDER:'gmail',MAIL_FROM:'notify@example.com',GMAIL_CLIENT_ID:'client',
   GMAIL_CLIENT_SECRET:undefined,GMAIL_REFRESH_TOKEN:'token',NODE_ENV:'test'});
 try{
   assert.equal(mail.configured(),false);
   await assert.rejects(mail.sendMail({to:'x@example.com',subject:'hello',text:'hi'}),{code:'MAIL_NOT_CONFIGURED'});
   assert.throws(()=>mail.makeMime({to:'x@example.com',subject:'Safe\r\nBcc: attacker@example.com',text:'body'}),{code:'INVALID_MAIL_INPUT'});
 }finally{restore();}
});
test('activation links are encrypted and authenticated in queued records',()=>{
 const restore=env({INVITE_MAIL_ENCRYPTION_KEY_HEX:crypto.randomBytes(32).toString('hex')});
 try{
   const url=(process.env.APP_URL||'http://localhost:3000').replace(/\/$/,'')+'/accept-invite#token='+'a'.repeat(64);
   const ciphertext=invites.seal(url);
   assert.equal(invites.open(ciphertext),url);
   assert(!ciphertext.includes('a'.repeat(64)),'bearer token never stored in plaintext');
   assert.throws(()=>invites.open(ciphertext.slice(0,-1)+'x'));
   assert.throws(()=>invites.seal('https://attacker.invalid/accept-invite#token='+'a'.repeat(64)));
 }finally{restore();}
});
