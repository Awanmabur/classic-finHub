'use strict';
const { appUrl, indexingEnabled } = require('./env');
const { NAME } = require('./tenantDatabaseName');
const INDEXABLE_PATHS = Object.freeze([
  '/', '/about', '/services', '/pricing', '/price-compare', '/faq', '/support',
  '/marketplace', '/product-guide', '/businesses', '/terms', '/privacy', '/cookies', '/refund-policy'
]);
const PRIVATE_PREFIXES = Object.freeze([
  '/platform', '/tenant', '/t/*/review', '/t/*/my-review', '/t/*/reviews', '/signin', '/signup', '/accept-invite',
  '/accept-staff-invite', '/mfa', '/forgot-password', '/reset-password', '/logout',
  '/health', '/integrations'
]);
const PUBLIC_PAGE_META = Object.freeze({
  '/marketplace':{title:'Finance Operations Software Modules | ClassicFin Hub',description:'Explore mobile money agent management, money transfer, banking and forex recordkeeping, cash controls, reporting and optional Android SMS capture modules.'},
  '/product-guide':{title:'Mobile Money & Finance Operations Software Guide | ClassicFin Hub',description:'See how ClassicFin Hub records mobile money and branch float, tracks cash counts and reconciliation, and produces reports from posted financial records.'},
  '/businesses':{title:'Find Finance Businesses | ClassicFin Hub Directory',description:'Find real businesses on ClassicFin Hub. Search published finance business profiles by name, services and country, and view public contact details and business pages.'}
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
function sitemapXml(extraPaths=[]) {
  // No guessed lastmod dates: update timestamps must describe actual content
  // revisions. The caller supplies owner-published profiles only.
  const profiles=extraPaths.filter(p=>typeof p==='string'&&p.startsWith('/t/')&&NAME.test(p.slice(3)));
  const paths=indexingEnabled?[...INDEXABLE_PATHS,...profiles]:[];
  const urls=[...new Set(paths)].map(p => `<url><loc>${xml(appUrl+p)}</loc></url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`;
}
function publicMetadata(path,title,{indexable=INDEXABLE_PATHS.includes(path),search=''}={}) {
  const page=PUBLIC_PAGE_META[path]||{},canonical=appUrl+path+search;
  const description=page.description||'ClassicFin Hub is a modular financial operations workspace by Classic Technologies.';
  return {title:page.title||title||'ClassicFin Hub',description,canonical,image:appUrl+'/images/classicfinhub-social.jpg',indexable,crawlAllowed:indexingEnabled,graph:{
    '@context':'https://schema.org','@graph':[
      {'@type':'Organization','@id':appUrl+'/#organization',name:'Classic Technologies',url:'https://classictechgroup.com'},
      {'@type':'WebSite','@id':appUrl+'/#website',name:'ClassicFin Hub',url:appUrl,publisher:{'@id':appUrl+'/#organization'}},
      {'@type':'WebPage','@id':canonical+'#webpage',url:canonical,name:page.title||title||'ClassicFin Hub',description,inLanguage:'en',isPartOf:{'@id':appUrl+'/#website'},publisher:{'@id':appUrl+'/#organization'}},
      ...((path==='/'||path==='/product-guide')?[{'@type':'SoftwareApplication','@id':appUrl+'/#application',name:'ClassicFin Hub',applicationCategory:'FinanceApplication',operatingSystem:'Web browser',url:appUrl,softwareVersion:require('../../package.json').version,description:'Multi-tenant financial operations software for manual mobile money, transfer, banking and forex records, branch cash controls and audited reporting.',provider:{'@id':appUrl+'/#organization'}}]:[]),
      ...(path!=='/'&&INDEXABLE_PATHS.includes(path)?[{'@type':'BreadcrumbList',itemListElement:[{'@type':'ListItem',position:1,name:'Home',item:appUrl+'/'},{'@type':'ListItem',position:2,name:(page.title||title||path.slice(1)).split('|')[0].trim(),item:canonical}]}]:[])
    ]
  }};
}
function tenantMetadata(tenant,landing){
  const path='/t/'+encodeURIComponent(tenant.slug),canonical=appUrl+path;
  const name=String(landing.name||tenant.name||'Business').slice(0,150);
  const details=landing.details||{};
  const description=String(landing.subtitle||landing.headline||name+' business profile').slice(0,220);
  const title=name+' | Business Profile | ClassicFin Hub';
  const indexable=Boolean(landing.publishedAt&&tenant.directoryListing?.visibility!=='hidden');
  const sameAs=[details.website,details.facebook,details.instagram,details.linkedin].filter(Boolean);
  const address=details.city&&landing.country?{ '@type':'PostalAddress',
    addressLocality:String(details.city),addressRegion:String(details.region||''),
    streetAddress:String(details.address||''),addressCountry:String(landing.country)}:undefined;
  const org={'@type':'Organization','@id':canonical+'#business',name,url:canonical,description,
    ...(address?{address}:{}),
    ...(landing.supportPhone?{telephone:String(landing.supportPhone)}:{}),
    ...(details.publicEmail?{email:String(details.publicEmail)}:{}),
    ...(details.logoUrl?{logo:details.logoUrl}:{}),
    ...(Array.isArray(landing.services)&&landing.services.length?{knowsAbout:landing.services}:{}),
    ...(sameAs.length?{sameAs}:{})};
  return {title,description,canonical,image:details.logoUrl||appUrl+'/images/classicfinhub-social.jpg',
    ...(details.logoUrl?{imageAlt:name+' logo'}:{}),
    indexable,crawlAllowed:indexingEnabled,graph:{'@context':'https://schema.org','@graph':[
      org,
      {'@type':'WebPage','@id':canonical+'#webpage',url:canonical,name:title,description,inLanguage:'en',
        about:{'@id':canonical+'#business'},isPartOf:{'@id':appUrl+'/#website'}},
      {'@type':'BreadcrumbList',itemListElement:[
        {'@type':'ListItem',position:1,name:'Home',item:appUrl+'/'},
        {'@type':'ListItem',position:2,name:'Businesses',item:appUrl+'/businesses'},
        {'@type':'ListItem',position:3,name,item:canonical}]}
      // Reviews are deliberately omitted from rich-result markup: we do not
      // advertise self-serving LocalBusiness/Organization rating stars.
    ]}};
}
function jsonLd(value){return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,char=>({'<':'\\u003c','>':'\\u003e','&':'\\u0026','\u2028':'\\u2028','\u2029':'\\u2029'}[char]));}
function llmsTxt() {
  // A public reading guide, not an indexing guarantee or access-control protocol.
  if(!indexingEnabled)return '# ClassicFin Hub\n\nThis instance has automated indexing disabled. Follow its robots.txt policy.\n';
  return `# ClassicFin Hub\n+
> ClassicFin Hub is a modular financial operations application by Classic Technologies. Tenant owners manage accounts and reconcile balances. Staff permissions and subscribed modules govern transaction entry, branch access and reports.

## Product and operation

- [Product guide](${appUrl}/product-guide) covers account setup, cash days, manual transactions and reporting.
- [Business directory](${appUrl}/businesses) lists public businesses. Owners publish the services and contact details shown on their profiles.
- [Home](${appUrl}/) provides a product overview and setup requests.
- [Modules](${appUrl}/services) describes subscribed operating capabilities.
- [Module marketplace](${appUrl}/marketplace) describes available modules.
- [Pricing](${appUrl}/pricing) lists current published subscription terms.
- [Plan comparison](${appUrl}/price-compare) lists published limits and included modules.
- [About](${appUrl}/about) introduces the product and company.
- [FAQs](${appUrl}/faq) covers setup, permissions, manual entry and SMS capture.
- [Support](${appUrl}/support) provides contact and setup help.

## Policies and discovery

- [Sitemap](${appUrl}/sitemap.xml) lists canonical public pages and published business profiles.
- [Crawler rules](${appUrl}/robots.txt) describe public crawl paths.
- [Terms](${appUrl}/terms)
- [Privacy](${appUrl}/privacy)
- [Cookies](${appUrl}/cookies)
- [Refund and cancellation policy](${appUrl}/refund-policy)

## Reading boundaries

Use public descriptions and current published prices. Financial books and dated observations do not establish live provider balances or automated settlement. Android SMS capture requires a configured gateway and supported message wording. Manual entry remains available. Subscription approvals are not proof of payment.

Authenticated dashboards, customer records, financial reports, gateway endpoints and invitation or reset links are outside these public resources. Follow the crawler rules and authentication requirements.
`;
}
module.exports = { INDEXABLE_PATHS, PRIVATE_PREFIXES, PUBLIC_PAGE_META, robotsTxt, sitemapXml, llmsTxt, publicMetadata, tenantMetadata, jsonLd };
