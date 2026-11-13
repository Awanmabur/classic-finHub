'use strict';
// Invitation links contain bearer tokens. Store only authenticated encryption
// in the transactional outbox, never raw URLs or tokens in database records/logs.
const crypto=require('node:crypto');
const {configured:mailConfigured}=require('./mail');
const appUrl=String(process.env.APP_URL||'http://localhost:3000').replace(/\/$/,'');
const KEY_NAME='INVITE_MAIL_ENCRYPTION_KEY_HEX';
function key(){
  const value=process.env[KEY_NAME]||'';
  if(!/^[a-f0-9]{64}$/i.test(value))return null;
  return Buffer.from(value,'hex');
}
function configured(){return Boolean(key())&&mailConfigured();}
function requireKey(){
  const k=key();
  if(!k){const e=new Error('Invite mail encryption key not configured');e.code='MAIL_INVITE_KEY_UNAVAILABLE';throw e;}
  return k;
}
function validateUrl(value){
  const url=new URL(value);
  if(url.origin!==appUrl||!['/accept-invite','/accept-staff-invite'].includes(url.pathname)||
    !/^#token=[a-f0-9]{64}$/i.test(url.hash))throw new Error('Invalid invitation destination');
  return url.toString();
}
function seal(url){
  const text=validateUrl(url),iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',requireKey(),iv);
  const encrypted=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
  return [iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');
}
function open(payload){
  if(typeof payload!=='string'||payload.length>4096||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(payload))throw new Error('Invalid invite ciphertext');
  const [iv,tag,data]=payload.split('.').map(s=>Buffer.from(s,'base64url'));
  if(iv.length!==12||tag.length!==16||!data.length)throw new Error('Invalid invitation encryption envelope');
  const cipher=crypto.createDecipheriv('aes-256-gcm',requireKey(),iv);
  cipher.setAuthTag(tag);
  return validateUrl(Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8'));
}
module.exports={configured,seal,open};
