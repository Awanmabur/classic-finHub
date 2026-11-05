'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const createApp=require('../src/app');
let server,origin;
test.before(async()=>{
  await new Promise(resolve=>{server=createApp().listen(0,resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));});

test('marketing and authentication pages load the approved fonts from this application',async()=>{
  for(const route of ['/','/signin','/signup','/forgot-password','/pricing','/services']){
    const response=await fetch(origin+route);
    assert.equal(response.status,200,route);
    const html=await response.text();
    assert.match(html,/href="\/vendor\/inter\/inter\.css\?v=[a-f0-9]{12}"/);
    assert.match(html,/href="\/vendor\/fontawesome\/css\/all\.min\.css\?v=[a-f0-9]{12}"/);
    assert.doesNotMatch(html,/(?:href|src)="https:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)/);
  }
  const dashboard=fs.readFileSync(path.join(__dirname,'../src/views/layouts/dashboard.ejs'),'utf8');
  assert.match(dashboard,/href="\/vendor\/inter\/inter\.css/);
  assert.match(dashboard,/href="\/vendor\/fontawesome\/css\/all\.min\.css/);
});

test('all font stylesheet URLs resolve to local valid WOFF2 responses',async()=>{
  const fonts=new Set();
  for(const sheet of ['/vendor/inter/inter.css','/vendor/fontawesome/css/all.min.css']){
    const response=await fetch(origin+sheet);
    assert.equal(response.status,200,sheet);
    assert.match(response.headers.get('content-type'),/text\/css/);
    const css=await response.text();
    for(const match of css.matchAll(/url\(["']?([^\s"')]+)["']?\)/g)){
      const font=new URL(match[1],origin+sheet);
      assert.equal(font.origin,origin,'font download must remain local');
      assert.match(font.pathname,/\.woff2$/);
      fonts.add(font.href);
    }
  }
  assert.equal(fonts.size,11,'Inter normal subsets and Font Awesome font families must all be available');
  for(const font of fonts){
    const response=await fetch(font);
    assert.equal(response.status,200,new URL(font).pathname);
    assert.match(response.headers.get('content-type'),/font\/woff2/);
    assert.match(response.headers.get('cache-control'),/public, max-age=86400/);
    const body=Buffer.from(await response.arrayBuffer());
    assert.equal(body.subarray(0,4).toString(),'wOF2','response must be an actual WOFF2 font');
    assert(body.length>1000,'font must not be an empty or truncated asset');
  }
});
