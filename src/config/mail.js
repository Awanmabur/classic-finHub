async function sendMail({ to, subject, html, text }) {
  console.log('[mail:mock]', { to, subject, text: text || html });
  return { status: 'queued', provider: 'mock' };
}
module.exports = { sendMail };
