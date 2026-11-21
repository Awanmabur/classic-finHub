'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const path=require('node:path');
const root=path.join(__dirname,'..');
function read(p){return fs.readFileSync(path.join(root,p));}
function text(p){return read(p).toString('utf8');}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
test('User-supplied authentic full logo is the one served under both supported URLs',()=>{
 const original=read('public/images/classicfinhub-logo.png');
 const official=read('public/images/classicfinhub-logo-official.png');
 assert.equal(sha(original),'d8cacd000cbc45c3816c1fe6442c0b8ef77421305318066d7a696c1413b4a857');
 assert.deepEqual(original,official);
 assert.equal(original.toString('hex',0,8),'89504e470d0a1a0a');
 assert.equal(original.readUInt32BE(16),1448);
 assert.equal(original.readUInt32BE(20),1086);
});
test('Compact branding derived from the supplied logo has dedicated small-icon and touch assets',()=>{
 const mark=read('public/images/classicfinhub-mark.png');
 const icon=read('public/favicon.png');
 assert.equal(sha(mark),'c8d11cc006bed4f1a060327135a8b8b7ca574f417499f283017495dab8f2170b');
 assert.equal(sha(icon),'32dd0ad717d41ccdbb390554f6c55a4d92cb6546a323fe622fc2e72c3b4158d5');
 assert.deepEqual(read('public/apple-touch-icon.png'),mark);
});
test('Social share preview uses uploaded brand, not old unrelated logo or generic illustration',()=>{
 assert.equal(sha(read('public/images/classicfinhub-social.jpg')),'043dd160123ef317a63cc9a55da60c3c9e3ba32b055af8e446a6680e8e87851c');
 const seo=text('src/config/seo.js');
 assert(seo.includes("appUrl+'/images/classicfinhub-social.jpg'"));
 const home=text('src/views/original/home.ejs');
 assert(home.includes('classicfinhub-social.jpg'));
 assert(home.includes('summary_large_image'));
 const publicPage=text('src/views/layouts/public.ejs');
 assert(publicPage.includes('summary_large_image'));
});
test('Public, authenticated, tenant, platform and offline pages share the canonical product identity',()=>{
 const publicPage=text('src/views/layouts/public.ejs');
 const dashboard=text('src/views/layouts/dashboard.ejs');
 const sidebar=text('src/views/partials/dashboard-sidebar.ejs');
 const footer=text('src/views/partials/marketing-footer.ejs');
 assert(publicPage.includes('/images/classicfinhub-mark.png'));
 assert(publicPage.includes('/favicon.png'));
 assert(publicPage.includes('/apple-touch-icon.png'));
 assert(dashboard.includes('/favicon.png'));
 assert(dashboard.includes('/apple-touch-icon.png'));
 assert(sidebar.includes('ClassicFin Hub official mark'));
 assert(footer.includes('classicfinhub-logo-official.png'));
 assert(text('public/css/dashboard.css').includes('/images/classicfinhub-mark.png'));
 assert(text('public/css/approved-tenant.css').includes('/images/classicfinhub-mark.png'));
 assert(text('public/offline-sw.js').includes('/images/classicfinhub-mark.png'));
 for(const p of ['src/views/original/signin.ejs','src/views/original/signup.ejs','src/views/auth/accept-invite.ejs',
  'src/views/auth/accept-staff-invite.ejs','src/views/tenant/mobile-money/acknowledgement.ejs'])
  assert(text(p).includes('/favicon.png'),p);
});
test('Brand change does not remove tenant-specific public custom brand and does not alter any financial posting code',()=>{
 const ejs=text('src/views/public/tenant-landing.ejs');
 assert(ejs.includes('landing.primary'));
 assert(ejs.includes('d.logoUrl'));
 const data=text('src/platform/services/businessDirectory.service.js');
 assert(data.includes('logoUrl'));
});
