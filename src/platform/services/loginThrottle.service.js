'use strict';
const crypto = require('crypto');
const LoginThrottle = require('../models/LoginThrottle');
const { normalizeEmail } = require('./authentication.service');
const { sessionSecret } = require('../../config/env');
const awaitAll=require('../../utils/awaitAll');
const WINDOW_MS = 15 * 60 * 1000;
function bucketId(category, value, now = Date.now()) {
  const bucket = Math.floor(now / WINDOW_MS);
  const digest = crypto.createHmac('sha256', sessionSecret).update(`${category}:${String(value || '').slice(0, 300)}`).digest('hex');
  return `${category}:${bucket}:${digest}`;
}
function tooMany() {
  const err = new Error('Too many sign-in attempts. Please try again later.');
  err.status = 429; return err;
}
async function consumeAttempt(email, ip, now = Date.now()) {
  // These counters are shared between app instances and survive restarts.
  // No plaintext email/IP is persisted; expiration is by bucket.
  const emailKey = bucketId('email', normalizeEmail(email) || '[invalid]', now);
  const ipKey = bucketId('ip', ip || '[unknown]', now);
  const expiresAt = new Date((Math.floor(now / WINDOW_MS) + 2) * WINDOW_MS);
  const update = { $inc: { count: 1 }, $setOnInsert: { expiresAt } };
  const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
  const [ipResult,emailResult] = await awaitAll([
    LoginThrottle.findOneAndUpdate({ _id: ipKey }, update, opts).lean(),
    LoginThrottle.findOneAndUpdate({ _id: emailKey }, update, opts).lean()
  ]);
  if (ipResult.count > 100 || emailResult.count > 8) throw tooMany();
}

async function consumeRecoveryAttempt(email, ip, now = Date.now()) {
  const ids = [bucketId('recovery-email', email || '[invalid]', now), bucketId('recovery-ip', ip || '[unknown]', now)];
  const expiresAt = new Date((Math.floor(now / WINDOW_MS) + 2) * WINDOW_MS);
  const update = { $inc: { count: 1 }, $setOnInsert: { expiresAt } };
  const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
  const counts = (await awaitAll(ids.map(_id=>LoginThrottle.findOneAndUpdate({ _id }, update, opts).lean()))).map(result=>result.count);
  if (counts[0] > 3 || counts[1] > 30) throw tooMany();
}
module.exports = { consumeAttempt, consumeRecoveryAttempt, bucketId, tooMany, WINDOW_MS };
