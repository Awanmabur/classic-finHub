'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('gallery uses accessible native modal, works with keyboard and touch, and retains original-image fallback',()=>{
 const page=read('src/views/public/tenant-landing.ejs'),js=read('public/js/business-profile.js'),css=read('public/css/business-directory.css');
 assert.match(page,/data-gallery-item/);assert.match(page,/data-business-gallery-dialog/);
 assert.match(page,/data-gallery-prev/);assert.match(page,/data-gallery-next/);
 assert.match(js,/dialog\.showModal\(\)/);assert.match(js,/ArrowLeft/);assert.match(js,/ArrowRight/);
 assert.match(js,/touchstart/);assert.match(js,/touchend/);
 assert.match(css,/\.galleryModalFigure img\{[^\n]*object-fit:contain/);
 assert.match(page,/View original image/);
});
test('mobile footer is left aligned and photographic covers keep stable object fit',()=>{
 const css=read('public/css/style.css'),business=read('public/css/business-directory.css');
 assert.match(css,/\.footer,.footer-inner,.footer-brand,.footer-column,.footer-note\{text-align:left!important\}/);
 assert.match(business,/\.publicBusinessCoverImage\{display:block;width:100%;height:100%;object-fit:cover/);
 assert.match(business,/\.publicBusinessAvatar img\{width:100%;height:100%;object-fit:contain/);
});
