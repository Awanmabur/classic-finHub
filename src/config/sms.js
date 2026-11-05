'use strict';
// Until an approved provider and verified delivery/webhook pipeline are configured,
// SMS must fail closed. Do not log phone numbers, message bodies or OTPs.
async function sendSms() {
  const err = new Error('SMS delivery is not configured; no message was sent.');
  err.status=503;
  throw err;
}
module.exports={sendSms};
