'use strict';
const crypto=require('node:crypto');
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function key(purpose){const root=process.env.MFA_ENCRYPTION_KEY;if(typeof root!=='string'||!/^[a-f0-9]{64}$/i.test(root))throw fail('Manual payout encryption key is not configured',503);return Buffer.from(crypto.hkdfSync('sha256',Buffer.from(root,'hex'),Buffer.from('ClassicFin manual remittance'),Buffer.from(purpose),32));}
function normalPhone(value){if(typeof value!=='string'||!/^\+[1-9]\d{7,14}$/.test(value.trim()))throw fail('Enter the international receiver phone beginning with +');return value.trim();}
function hash(pin,{tenantId,branchId,phone}){if(typeof pin!=='string'||!/^\d{6}$/.test(pin))throw fail('Enter the six-digit payout PIN');return crypto.createHmac('sha256',key('pin-lookup-v1')).update(`${tenantId}:${branchId}:${normalPhone(phone)}:${pin}`).digest('hex');}
function generate(){return String(crypto.randomInt(0,1000000)).padStart(6,'0');}
function encrypt(pin,binding){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key('pin-display-v1'),iv);cipher.setAAD(Buffer.from(binding));const body=Buffer.concat([cipher.update(pin,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),body].map(value=>value.toString('base64url')).join('.');}
function decrypt(value,binding){if(typeof value!=='string'||value.split('.').length!==3)throw fail('Payout PIN is unavailable',409);const [iv,tag,body]=value.split('.').map(part=>Buffer.from(part,'base64url'));if(iv.length!==12||tag.length!==16)throw fail('Payout PIN is unavailable',409);const decipher=crypto.createDecipheriv('aes-256-gcm',key('pin-display-v1'),iv);decipher.setAAD(Buffer.from(binding));decipher.setAuthTag(tag);return Buffer.concat([decipher.update(body),decipher.final()]).toString('utf8');}
function tokenHash(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/i.test(value))throw fail('Payout verification expired. Check the PIN again.',409);return crypto.createHash('sha256').update(value).digest('hex');}
module.exports={hash,generate,encrypt,decrypt,normalPhone,tokenHash};
