'use strict';
const crypto=require('node:crypto');
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function key(){
  const value=process.env.MFA_ENCRYPTION_KEY||'';
  if(!/^[a-f0-9]{64}$/i.test(value))throw fail('SMS credential encryption is not configured.',503);
  return crypto.createHmac('sha256',Buffer.from(value,'hex')).update('classicfin:sms-capture:v1').digest();
}
function encrypt(value,context){
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);
  cipher.setAAD(Buffer.from(String(context)));
  const bytes=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),bytes].map(v=>v.toString('base64url')).join('.');
}
function decrypt(value,context){
  try{
    const parts=String(value).split('.');
    if(parts.length!==3)throw Error();
    const [iv,tag,bytes]=parts.map(v=>Buffer.from(v,'base64url'));
    if(iv.length!==12||tag.length!==16)throw Error();
    const decipher=crypto.createDecipheriv('aes-256-gcm',key(),iv);
    decipher.setAAD(Buffer.from(String(context)));decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(bytes),decipher.final()]).toString('utf8');
  }catch{throw fail('SMS encrypted data is unavailable. Contact the platform administrator.',503);}
}
function verifySignature(secret,raw,timestamp,signature,now=Date.now()){
  if(!/^[0-9]{10}$/.test(String(timestamp||''))||Math.abs(now-Number(timestamp)*1000)>300000||
    typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!Buffer.isBuffer(raw))return false;
  const expected=crypto.createHmac('sha256',Buffer.from(secret,'hex')).update(`${timestamp}.`).update(raw).digest();
  return crypto.timingSafeEqual(expected,Buffer.from(signature,'hex'));
}
function idempotencyKey(deviceId,messageId){
  const bytes=crypto.createHash('sha256').update(`sms:${deviceId}:${messageId}`).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const value=bytes.toString('hex');
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
module.exports={encrypt,decrypt,verifySignature,idempotencyKey,fail};
