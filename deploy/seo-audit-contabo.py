#!/usr/bin/env python3
"""Read-only production SEO acceptance checks. No database, Caddy or GSC writes."""
from html.parser import HTMLParser
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import sys
import json
import xml.etree.ElementTree as ET

ORIGIN = 'https://classicfinhub.com'
PUBLIC = ('/', '/about', '/services', '/pricing', '/price-compare', '/faq',
          '/support', '/marketplace', '/product-guide', '/terms', '/privacy',
          '/cookies', '/refund-policy')
failures = []

class HtmlAudit(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title = ''
        self.in_title = False
        self.in_json = False
        self.json_buffer = ''
        self.schemas = []
        self.meta = {}
        self.canonicals = []
        self.h1 = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'title':
            self.in_title = True
        elif tag == 'h1':
            self.h1 += 1
        elif tag == 'meta':
            self.meta[a.get('name', '').lower() or a.get('property', '').lower()] = a.get('content', '')
        elif tag == 'link' and 'canonical' in a.get('rel', '').lower().split():
            self.canonicals.append(a.get('href'))
        elif tag == 'script' and a.get('type') == 'application/ld+json':
            self.in_json = True
            self.json_buffer = ''

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        if self.in_json:
            self.json_buffer += data

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False
        elif tag == 'script' and self.in_json:
            self.in_json = False
            try:
                self.schemas.append(json.loads(self.json_buffer))
            except (TypeError, ValueError):
                self.schemas.append(None)

def fetch(url):
    request = Request(url, headers={'User-Agent': 'ClassicFin-Public-SEO-Preflight/1.0'})
    try:
        with urlopen(request, timeout=20) as response:
            return response.status, response.url, response.headers, response.read(3_000_000).decode('utf-8', 'replace')
    except HTTPError as error:
        return error.code, error.url, error.headers, ''
    except (URLError, TimeoutError, OSError) as error:
        raise RuntimeError(type(error).__name__) from None

def check(ok, label):
    print(('PASS ' if ok else 'FAIL ') + label)
    if not ok:
        failures.append(label)

print('=== CLASSIC FINHUB PUBLIC SEO ACCEPTANCE ===')
for path in PUBLIC:
    url = ORIGIN + path
    try:
        status, final, headers, html = fetch(url)
        parser = HtmlAudit()
        parser.feed(html)
        problems = []
        if status != 200:
            problems.append('HTTP ' + str(status))
        if final != url:
            problems.append('unexpected canonical redirect')
        if 'noindex' in headers.get('X-Robots-Tag', '').lower():
            problems.append('X-Robots-Tag noindex')
        if not 8 <= len(parser.title.strip()) <= 85:
            problems.append('title missing/too long')
        if not 50 <= len(parser.meta.get('description', '')) <= 190:
            problems.append('meta description missing/too long')
        if parser.canonicals != [url]:
            problems.append('canonical mismatch')
        if 'noindex' in parser.meta.get('robots', '').lower():
            problems.append('HTML noindex')
        if not parser.h1:
            problems.append('H1 missing')
        if not parser.meta.get('og:title') or not parser.meta.get('og:description'):
            problems.append('Open Graph metadata missing')
        if not parser.schemas or any(x is None for x in parser.schemas):
            problems.append('JSON-LD missing/invalid')
        check(not problems, path + (': ' + ', '.join(problems) if problems else ''))
    except Exception as error:
        check(False, path + ': request/parser failed (' + type(error).__name__ + ')')

print('=== CRAWLER DISCOVERY ===')
try:
    status, final, headers, robots = fetch(ORIGIN + '/robots.txt')
    lines = [line.strip() for line in robots.splitlines()]
    check(status == 200 and 'Disallow: /' not in lines and
          'Sitemap: ' + ORIGIN + '/sitemap.xml' in lines,
          'robots.txt public sitemap and no global blockade')
    for prefix in ('/tenant', '/platform', '/signin', '/integrations', '/t/'):
        check('Disallow: ' + prefix in lines, 'robots.txt excludes private ' + prefix)
except Exception as error:
    check(False, 'robots.txt: ' + type(error).__name__)
try:
    status, final, headers, text = fetch(ORIGIN + '/sitemap.xml')
    root = ET.fromstring(text)
    namespace = '{http://www.sitemaps.org/schemas/sitemap/0.9}'
    urls = [x.text for x in root.iter(namespace + 'loc')]
    expected = [ORIGIN + item for item in PUBLIC]
    check(status == 200 and len(urls) == len(set(urls)) and sorted(urls) == sorted(expected),
          'sitemap.xml exactly matches 13 canonical public pages')
except Exception as error:
    check(False, 'sitemap.xml: ' + type(error).__name__)
try:
    status, final, headers, text = fetch(ORIGIN + '/llms.txt')
    check(status == 200 and ORIGIN + '/product-guide' in text and
          'automated indexing disabled' not in text,
          'llms.txt public product and policy references')
except Exception as error:
    check(False, 'llms.txt: ' + type(error).__name__)

print('=== PRIVATE AND ALTERNATE URL HANDLING ===')
for path in ('/signin', '/signup'):
    try:
        status, final, headers, html = fetch(ORIGIN + path)
        check(status == 200 and 'noindex' in headers.get('X-Robots-Tag', '').lower(),
              path + ' has private noindex response')
    except Exception as error:
        check(False, path + ': ' + type(error).__name__)
try:
    status, final, headers, html = fetch('https://www.classicfinhub.com/')
    check(status == 200 and final == ORIGIN + '/', 'www redirects to canonical https')
except Exception as error:
    check(False, 'www redirect: ' + type(error).__name__)
try:
    status, final, headers, html = fetch(ORIGIN + '/definitely-not-a-real-page-404-seo')
    check(status == 404, 'unknown page is a real HTTP 404')
except Exception as error:
    check(False, '404 probe: ' + type(error).__name__)

print('=== RESULT ===')
if failures:
    print('BLOCKED:', len(failures), 'checks failed. Do not submit to Search Console yet.')
    sys.exit(1)
print('PASS: Technical SEO acceptance; Google indexing/ranking remains independent.')
