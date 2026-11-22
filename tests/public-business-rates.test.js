'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('published business uses approved, unexpired, tenant-scoped Forex rates',()=>{
 const service=read('src/tenant/workspace/publicRates.js');
 assert.match(service,/hasModule\(tenant,'forex'\)/);
 assert.match(service,/status:'active'/);
 assert.match(service,/reviewedAt:\{\$exists:true,\$ne:null\}/);
 assert.match(service,/expiresAt:\{\$gt:now\}/);
 assert.match(service,/branchId:\{\$in:branches/);
 assert.doesNotMatch(service,/customerLabel|customerPhone/);
});
test('public company identity stays below the cover, and rates beside About on desktop',()=>{
 const css=read('public/css/business-directory.css'),ejs=read('src/views/public/tenant-landing.ejs');
 assert.match(css,/\.publicBusinessHeading\{margin-top:0/);
 assert.match(css,/\.publicBusinessAvatar img\{width:100%;height:100%;object-fit:contain/);
 assert.match(css,/\.publicBusinessAboutRates\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
 assert.match(ejs,/publicBusinessRateSection/);
 assert.match(ejs,/new Date\(rate.expiresAt\)/);
});
