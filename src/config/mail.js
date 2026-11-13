'use strict';
// Production delivery uses a real provider; acceptance is not inbox delivery.
// Never log provider response bodies or the OAuth refresh token.
const crypto=require('node:crypto');
const appUrl=process.env.APP_URL || 'http://localhost:3000';
const RESEND_ENDPOINT='https://api.resend.com/emails';
const GMAIL_TOKEN_ENDPOINT='https://oauth2.googleapis.com/token';
const GMAIL_SEND_ENDPOINT='https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const ADDRESS=/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/;
const provider=()=>String(process.env.MAIL_PROVIDER||'resend').toLowerCase();
function configured() {
  if(!process.env.MAIL_FROM||!(/^https:\/\//i.test(appUrl)||process.env.NODE_ENV!=='production'))return false;
  // Gmail requires a plain mailbox/verified send-as alias; preserve Resend's
  // supported \"Display Name <sender@example.com>\" format in existing installs.
  if(provider()==='gmail')return ADDRESS.test(process.env.MAIL_FROM)&&Boolean(process.env.GMAIL_CLIENT_ID&&process.env.GMAIL_CLIENT_SECRET&&process.env.GMAIL_REFRESH_TOKEN);
  return provider()==='resend'&&Boolean(process.env.RESEND_API_KEY);
}
function requireConfigured() {
  if(configured())return;
  const error=new Error('Email delivery is not configured. Configure MAIL_PROVIDER, MAIL_FROM, and the chosen mail provider credentials.');
  error.status=503;error.code='MAIL_NOT_CONFIGURED';throw error;
}
function safeMailInput({to,subject,text}) {
  if(!ADDRESS.test(String(to||''))||String(to).length>254||
    typeof subject!=='string'||!subject||subject.length>180||/[\r\n]/.test(subject)||
    typeof text!=='string'||!text||text.length>16000) {
    const error=new Error('Invalid email metadata');error.code='INVALID_MAIL_INPUT';throw error;
  }
}
function makeMime({to,subject,text,idempotencyKey}){
  safeMailInput({to,subject,text});
  const from=process.env.MAIL_FROM;
  const domain=from.split('@')[1];
  const id=crypto.createHash('sha256').update(idempotencyKey||crypto.randomUUID()).digest('hex').slice(0,32);
  const encodedSubject='=?UTF-8?B?'+Buffer.from(subject,'utf8').toString('base64')+'?=';
  // CRLF and base64 body prevent MIME header injection and preserve Unicode text.
  const encodedBody=Buffer.from(text.replace(/\r?\n/g,'\r\n'),'utf8').toString('base64').replace(/.{1,76}/g,'$&\r\n').trimEnd();
  return ['From: <'+from+'>','To: <'+to+'>','Subject: '+encodedSubject,
    'Date: '+new Date().toUTCString(),'Message-ID: <cfh-'+id+'@'+domain+'>',
    'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64','',encodedBody,''].join('\r\n');
}
async function sendGmail({to,subject,text,idempotencyKey}){
  const tokenResponse=await fetch(GMAIL_TOKEN_ENDPOINT,{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:process.env.GMAIL_CLIENT_ID,client_secret:process.env.GMAIL_CLIENT_SECRET,refresh_token:process.env.GMAIL_REFRESH_TOKEN,grant_type:'refresh_token'}),
    signal:AbortSignal.timeout(10000)
  });
  if(!tokenResponse.ok){const error=new Error('Gmail authorization failed');error.providerStatus=tokenResponse.status;throw error;}
  const token=await tokenResponse.json();
  if(!token?.access_token){const error=new Error('Gmail token response invalid');error.providerStatus=503;throw error;}
  const raw=Buffer.from(makeMime({to,subject,text,idempotencyKey}),'utf8').toString('base64url');
  const response=await fetch(GMAIL_SEND_ENDPOINT,{
    method:'POST',headers:{authorization:'Bearer '+token.access_token,'content-type':'application/json'},
    body:JSON.stringify({raw}),signal:AbortSignal.timeout(15000)
  });
  if(!response.ok){const error=new Error('Gmail provider rejected message');error.providerStatus=response.status;throw error;}
  const receipt=await response.json();
  if(!receipt?.id){const error=new Error('Gmail provider did not confirm acceptance');error.providerStatus=503;throw error;}
  return {provider:'gmail',messageId:receipt.id,status:'accepted'};
}
async function sendResend({to,subject,text,idempotencyKey}){
  const response=await fetch(RESEND_ENDPOINT,{
    method:'POST',headers:{authorization:'Bearer '+process.env.RESEND_API_KEY,'content-type':'application/json','user-agent':'ClassicFinHub/1.30',...(idempotencyKey?{'idempotency-key':idempotencyKey}:{})},
    body:JSON.stringify({from:process.env.MAIL_FROM,to:[to],subject,text}),
    signal:AbortSignal.timeout(10000)
  });
  if(!response.ok){const error=new Error('Email provider rejected the request');error.providerStatus=response.status;throw error;}
  const receipt=await response.json();
  if(!receipt?.id){const error=new Error('Email provider gave no accepted message identifier');error.providerStatus=503;throw error;}
  return {provider:'resend',messageId:receipt.id,status:'accepted'};
}
async function sendMail(input) {
  requireConfigured();
  safeMailInput(input);
  return provider()==='gmail'?sendGmail(input):sendResend(input);
}
module.exports={sendMail,configured,provider,makeMime};
