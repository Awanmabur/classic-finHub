'use strict';
// Standards-based TOTP (RFC 6238); codes never enter URLs, analytics or logs.
const crypto = require('crypto');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const MAX_ATTEMPTS = 5;
const PENDING_MS = 5 * 60 * 1000;

function bad(message = 'Invalid verification code.', status = 400) {
  const error = new Error(message); error.status = status; return error;
}
function key() {
  const input = process.env.MFA_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(input)) throw bad('Authenticator encryption key is not configured.', 503);
  return Buffer.from(input, 'hex');
}
function toBase32(bytes) {
  let buffer = 0, bits = 0, output = '';
  for (const value of bytes) {
    buffer = (buffer << 8) | value; bits += 8;
    while (bits >= 5) { output += ALPHABET[(buffer >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) output += ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}
function fromBase32(value) {
  if (typeof value !== 'string' || !/^[A-Z2-7]{32}$/.test(value)) throw bad('Invalid authenticator secret');
  let buffer = 0, bits = 0; const bytes = [];
  for (const c of value) {
    buffer = (buffer << 5) | ALPHABET.indexOf(c); bits += 5;
    if (bits >= 8) { bytes.push((buffer >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
function generateSecret() { return toBase32(crypto.randomBytes(20)); }
function encryptSecret(secret) {
  fromBase32(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),ciphertext].map(b => b.toString('base64url')).join('.');
}
function decryptSecret(value) {
  if (typeof value !== 'string') throw bad('Authenticator secret is unavailable', 503);
  const parts = value.split('.');
  if (parts.length !== 3) throw bad('Authenticator secret is unavailable', 503);
  const [iv,tag,ciphertext] = parts.map(p => Buffer.from(p,'base64url'));
  if (iv.length !== 12 || tag.length !== 16) throw bad('Authenticator secret is invalid', 503);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  const secret = Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');
  fromBase32(secret);
  return secret;
}
function counterCode(secret, counter) {
  if (!Number.isSafeInteger(counter) || counter < 0) throw bad('Invalid authenticator counter');
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', fromBase32(secret)).update(buffer).digest();
  const index = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(index) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function verifyCode(secret, code, lastCounter = -1, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / (STEP_SECONDS * 1000));
  for (let delta = -1; delta <= 1; delta++) {
    const counter = current + delta;
    if (counter <= lastCounter || counter < 0) continue;
    const expected = counterCode(secret, counter);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return counter;
  }
  return null;
}
// Legacy account rows without authVersion are equivalent to version zero.
// MFA setup must not lock out users migrated from pre-versioned schemas.
function authVersionFilter(version) { return version === 0 ? { $in: [0, null] } : version; }
function pendingSession(req) {
  const pending = req.session?.pendingMfa;
  if (!pending || !Number.isSafeInteger(pending.startedAt) || pending.startedAt > Date.now() || Date.now() - pending.startedAt > PENDING_MS) return null;
  if (!pending.identityId || !Number.isSafeInteger(pending.authVersion)) return null;
  const platform = Boolean(pending.platformId) && !pending.tenantId && !pending.tenantUserId;
  const tenant = !pending.platformId && Boolean(pending.tenantId) && Boolean(pending.tenantUserId) && pending.kind === 'tenant';
  if (!platform && !tenant) return null;
  return pending;
}
function recordAttempt(pending) {
  pending.attempts = (pending.attempts || 0) + 1;
  if (pending.attempts > MAX_ATTEMPTS) throw bad('Too many verification attempts. Sign in again.',429);
}
module.exports = { generateSecret, encryptSecret, decryptSecret, counterCode, verifyCode, pendingSession, recordAttempt, authVersionFilter, MAX_ATTEMPTS, PENDING_MS };
