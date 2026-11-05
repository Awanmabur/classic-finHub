'use strict';
// Explicit real provider integration. Never report mock or unverified email as sent.
// Standalone worker does not need the web app's session or MFA secrets.
const appUrl = process.env.APP_URL || 'http://localhost:3000';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
function configured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM &&
    (/^https:\/\//i.test(appUrl) || process.env.NODE_ENV !== 'production'));
}
async function sendMail({ to, subject, text, idempotencyKey }) {
  if (!configured()) {
    const err = new Error('Email delivery is not configured. Set RESEND_API_KEY and MAIL_FROM, and use HTTPS in production.');
    err.status = 503; err.code = 'MAIL_NOT_CONFIGURED'; throw err;
  }
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json', 'user-agent': 'ClassicFinHub/1.2', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
    signal: AbortSignal.timeout(10000)
  });
  // Do not leak provider response contents or authentication secrets to users/logs.
  if (!response.ok) {
    const err = new Error(`Email delivery provider rejected the request (HTTP ${response.status}).`);
    err.status = 503; err.providerStatus=response.status; throw err;
  }
  const body = await response.json();
  if (!body?.id) {
    const err = new Error('Email delivery provider gave no accepted message identifier.');
    err.status = 503; throw err;
  }
  return { provider: 'resend', messageId: body.id, status: 'accepted' };
}
module.exports = { sendMail, configured };
