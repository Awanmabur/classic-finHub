async function sendSms({ to, message }) {
  console.log('[sms:mock]', { to, message });
  return { status: 'queued', provider: 'mock' };
}
module.exports = { sendSms };
