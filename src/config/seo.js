'use strict';
const { appUrl, indexingEnabled } = require('./env');
const INDEXABLE_PATHS = Object.freeze([
  '/', '/about', '/services', '/pricing', '/price-compare', '/faq', '/support',
  '/marketplace', '/product-guide', '/terms', '/privacy', '/cookies', '/refund-policy'
]);
const PRIVATE_PREFIXES = Object.freeze([
  '/platform', '/tenant', '/t/', '/signin', '/signup', '/accept-invite',
  '/accept-staff-invite', '/mfa', '/forgot-password', '/reset-password', '/logout',
  '/health', '/integrations'
]);
const PUBLIC_PAGE_META = Object.freeze({
  '/marketplace':{title:'Module marketplace | ClassicFin Hub',description:'Explore separately subscribed ClassicFin Hub modules for reviewed manual financial operations, reports, analytics and supported Android SMS capture.'},
  '/product-guide':{title:'Product and operating guide | ClassicFin Hub',description:'Understand ClassicFin Hub tenant workspaces, manual financial books, wallet funding, independent review, branch views, reports and supported SMS capture.'}
});
const xml=value=>String(value).replace(/[&<>\"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&apos;'}[char]));
function robotsTxt() {
  if (!indexingEnabled) return 'User-agent: *\nDisallow: /\n';
  // The wildcard applies to search and AI crawlers alike. These declarations
  // supplement authentication; robots.txt is never an authorization boundary.
  return [
    'User-agent: *', 'Allow: /',
    ...PRIVATE_PREFIXES.map(prefix => `Disallow: ${prefix}`),
    `Sitemap: ${appUrl}/sitemap.xml`, ''
  ].join('\n');
}
function sitemapXml() {
  // No guessed lastmod dates: update timestamps must describe actual content
  // revisions. Authenticated and tenant-branded paths are deliberately absent.
  const urls = (indexingEnabled?INDEXABLE_PATHS:[]).map(p => `<url><loc>${xml(appUrl+p)}</loc></url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`;
}
function publicMetadata(path,title) {
  const page=PUBLIC_PAGE_META[path]||{},canonical=appUrl+path;
  const description=page.description||'ClassicFin Hub is a modular financial operations workspace by Classic Technologies.';
  return {title:page.title||title||'ClassicFin Hub',description,canonical,image:appUrl+'/images/classicfinhub-logo.png',indexable:INDEXABLE_PATHS.includes(path),graph:{
    '@context':'https://schema.org','@graph':[
      {'@type':'Organization','@id':appUrl+'/#organization',name:'Classic Technologies',url:appUrl,logo:appUrl+'/images/classicfinhub-logo.png'},
      {'@type':'WebSite','@id':appUrl+'/#website',name:'ClassicFin Hub',url:appUrl,publisher:{'@id':appUrl+'/#organization'}},
      {'@type':'WebPage','@id':canonical+'#webpage',url:canonical,name:page.title||title||'ClassicFin Hub',description,inLanguage:'en',isPartOf:{'@id':appUrl+'/#website'},publisher:{'@id':appUrl+'/#organization'}},
      ...(path==='/product-guide'?[{'@type':'SoftwareApplication','@id':appUrl+'/#application',name:'ClassicFin Hub',applicationCategory:'FinanceApplication',operatingSystem:'Web browser',url:appUrl,softwareVersion:require('../../package.json').version,description,publisher:{'@id':appUrl+'/#organization'}}]:[])
    ]
  }};
}
function jsonLd(value){return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,char=>({'<':'\\u003c','>':'\\u003e','&':'\\u0026','\u2028':'\\u2028','\u2029':'\\u2029'}[char]));}
function llmsTxt() {
  // A public reading guide, not an indexing guarantee or access-control protocol.
  if(!indexingEnabled)return '# ClassicFin Hub\n\nThis instance has automated indexing disabled. Follow its robots.txt policy.\n';
  return `# ClassicFin Hub\n\n> ClassicFin Hub is a modular financial operations application by Classic Technologies. It supports tenant workspaces, independently reviewed manual funds books, staff permissions, branch controls and reports.\n\n## Product and operation\n\n- [Product guide](${appUrl}/product-guide): current workflows and their operating boundaries.\n- [Home](${appUrl}/): overview and onboarding requests.\n- [Modules](${appUrl}/services): subscribed operational capabilities.\n- [Module marketplace](${appUrl}/marketplace): available module descriptions.\n- [Pricing](${appUrl}/pricing): current published subscription terms.\n- [Plan comparison](${appUrl}/price-compare): published limits and included modules.\n- [About](${appUrl}/about): product and company information.\n- [FAQs](${appUrl}/faq): setup, permissions, manual entry and SMS capture.\n- [Support](${appUrl}/support): contact and onboarding help.\n\n## Policies\n\n- [Terms](${appUrl}/terms)\n- [Privacy](${appUrl}/privacy)\n- [Cookies](${appUrl}/cookies)\n- [Refund and cancellation policy](${appUrl}/refund-policy)\n\n## Reading boundaries\n\nUse public descriptions and current published prices. Financial books and dated observations do not establish live provider balances or automated settlement. Android SMS capture requires a configured gateway and supported message wording; manual entry remains available. Subscription approvals are not proof of payment.\n\nAuthenticated dashboards, customer records, financial reports, gateway endpoints and invitation/reset links are outside these public resources. Respect robots.txt and authentication; never attempt to retrieve private information.\n`;
}
module.exports = { INDEXABLE_PATHS, PRIVATE_PREFIXES, PUBLIC_PAGE_META, robotsTxt, sitemapXml, llmsTxt, publicMetadata, jsonLd };
