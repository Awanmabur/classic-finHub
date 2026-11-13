'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const seo = require('../src/config/seo');
const { appUrl, indexingEnabled } = require('../src/config/env');

const templatePath = name => path.join(__dirname, '..', 'src', 'views', 'original', name + '.ejs');
const marketingPages = Object.freeze(['home', 'services', 'about', 'pricing', 'price-compare', 'faq', 'support']);

test('only canonical public pages are eligible for sitemap inclusion', () => {
  assert.equal(seo.INDEXABLE_PATHS.length, new Set(seo.INDEXABLE_PATHS).size);
  assert.equal(seo.INDEXABLE_PATHS.length, 13);
  for (const urlPath of seo.INDEXABLE_PATHS) {
    assert.match(urlPath, /^\/(?:[a-z-]+)?$/);
    assert.equal(seo.PRIVATE_PREFIXES.some(prefix => urlPath === prefix || urlPath.startsWith(prefix + '/')), false);
  }
  const sitemap = seo.sitemapXml();
  for (const urlPath of seo.INDEXABLE_PATHS) {
    const expected = '<loc>' + appUrl + urlPath + '</loc>';
    assert.equal(sitemap.includes(expected), indexingEnabled, urlPath);
  }
  for (const secretPath of ['/tenant', '/platform', '/signin', '/signup', '/integrations', '/t/demo']) {
    assert.equal(sitemap.includes(appUrl + secretPath + '</loc>'), false);
    assert.equal(seo.publicMetadata(secretPath, 'Private').indexable, false);
  }
});

test('sitewide crawling gate is respected by sitemap, HTML metadata and robots', () => {
  const robots = seo.robotsTxt();
  if (!indexingEnabled) {
    assert.match(robots, /Disallow: \/\s*$/m);
    assert.doesNotMatch(robots, /Sitemap:/);
    assert.equal(seo.publicMetadata('/', 'Home').indexable, true);
    assert.equal(seo.publicMetadata('/', 'Home').crawlAllowed, false);
  } else {
    assert.match(robots, /^User-agent: \*$/m);
    assert.match(robots, /Sitemap:/);
    assert.match(robots, /Disallow: \/tenant/m);
    assert.match(robots, /Disallow: \/integrations/m);
    assert.equal(seo.publicMetadata('/', 'Home').indexable, true);
    assert.equal(seo.publicMetadata('/', 'Home').crawlAllowed, true);
  }
});

test('each indexable original marketing page has unique, aligned title and description tags', () => {
  const seenTitles = new Set();
  const seenDescriptions = new Set();
  for (const name of marketingPages) {
    const template = fs.readFileSync(templatePath(name), 'utf8');
    const title = template.match(/<title>([^<]+)<\/title>/)?.[1];
    const description = template.match(/<meta name="description" content="([^"]+)"\s*\/>/)?.[1];
    assert.ok(title, name + ' title missing');
    assert.ok(description, name + ' description missing');
    assert.ok(title.length >= 35 && title.length <= 75, name + ' title length');
    assert.ok(description.length >= 110 && description.length <= 170, name + ' description length');
    assert.equal(seenTitles.has(title), false, name + ' repeated title');
    assert.equal(seenDescriptions.has(description), false, name + ' repeated description');
    seenTitles.add(title); seenDescriptions.add(description);
    assert.ok(template.includes('content="' + title + '"'), name + ' Open Graph title');
    assert.ok(template.includes('content="' + description + '"'), name + ' Open Graph description');
    assert.ok(template.includes('rel="canonical" href="<%= appUrl %>/' + (name === 'home' ? '' : name) + '"'), name + ' canonical');
    assert.match(template, /<h1\b/, name + ' heading missing');
  }
});

test('public data describes software honestly, without asserting live settlement', () => {
  const page = seo.publicMetadata('/product-guide', 'Product guide');
  const graph = page.graph['@graph'];
  assert.equal(graph.find(x => x['@type'] === 'Organization').url, 'https://classictechgroup.com');
  assert.equal(graph.find(x => x['@type'] === 'SoftwareApplication').operatingSystem, 'Web browser');
  assert.ok(graph.find(x => x['@type'] === 'BreadcrumbList'));
  assert.match(page.description, /mobile money/i);
  assert.match(seo.llmsTxt(), /manual|indexing disabled/i);
  assert.ok(!seo.llmsTxt().includes('live automated settlement'));
  assert.doesNotMatch(seo.jsonLd({'a':'</script><x>'}), /<script>|<x>/);
});
