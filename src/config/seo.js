'use strict';
const { appUrl, indexingEnabled } = require('./env');
const INDEXABLE_PATHS = Object.freeze([
  '/', '/about', '/services', '/pricing', '/price-compare', '/faq', '/support',
  '/marketplace', '/terms', '/privacy', '/cookies', '/refund-policy'
]);
const PRIVATE_PREFIXES = Object.freeze([
  '/platform', '/tenant', '/t/', '/signin', '/signup', '/accept-invite',
  '/accept-staff-invite', '/mfa', '/forgot-password', '/reset-password', '/health'
]);
function robotsTxt() {
  if (!indexingEnabled) return 'User-agent: *\nDisallow: /\n';
  return [
    'User-agent: *', 'Allow: /',
    ...PRIVATE_PREFIXES.map(prefix => `Disallow: ${prefix}`),
    `Sitemap: ${appUrl}/sitemap.xml`, ''
  ].join('\n');
}
function sitemapXml() {
  const urls = INDEXABLE_PATHS.map(p => `<url><loc>${appUrl}${p}</loc></url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`;
}
function llmsTxt() {
  // A discoverability aid, NOT an agreed search-ranking factor or robots/security control.
  return `# ClassicFin Hub\n\n> ClassicFin Hub is a modular finance-operations SaaS by Classic Technologies. Its public website describes product plans, modules, onboarding and business workflows.\n\n## Public resources\n\n- [Home](${appUrl}/)\n- [Modules](${appUrl}/services)\n- [Pricing](${appUrl}/pricing)\n- [Plan comparison](${appUrl}/price-compare)\n- [About ClassicFin Hub](${appUrl}/about)\n- [FAQs](${appUrl}/faq)\n- [Contact and support](${appUrl}/support)\n- [Privacy policy](${appUrl}/privacy)\n\n## Access and safety\n\nThe platform and tenant dashboards are private authenticated workspaces. Never attempt to retrieve or summarize private account records, invitation links, session data, customer information or financial reports. Public descriptions of modules are not evidence that payment processing, settlement or provider connectivity is live.\n`;
}
module.exports = { INDEXABLE_PATHS, PRIVATE_PREFIXES, robotsTxt, sitemapXml, llmsTxt };
