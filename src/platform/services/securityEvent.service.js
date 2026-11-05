'use strict';
const crypto = require('crypto');
const SecurityEvent = require('../models/SecurityEvent');
const { normalizeEmail } = require('./authentication.service');
const { sessionSecret } = require('../../config/env');
function digest(value) { return crypto.createHmac('sha256', sessionSecret).update(String(value || '').slice(0, 300)).digest('hex'); }
async function record(action, { email, ip, identityId } = {}) {
  // Never include credentials or raw email/IP in security events.
  await SecurityEvent.create({ action, subjectHash: digest(normalizeEmail(email)), ipHash: digest(ip), identityId: identityId || null });
}
module.exports = { record, digest };
