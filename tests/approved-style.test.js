'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const reference=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/\r\n/g,'\n');
const stylesheet=fs.readFileSync(path.join(root,'public/css/approved-tenant.css'),'utf8');

test('tenant styles retain every approved style block in document order, including the late navy palette',()=>{
 const blocks=[...reference.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)];
 assert.equal(blocks.length,16,'The final reference has sixteen cascading style blocks');
 let cursor=stylesheet.indexOf('/* BEGIN APPROVED INDEX.HTML CASCADE */');
 for(const block of blocks){
  const css=block[2].trim().replace(/url\((["']?)images\//g,'url($1/images/').replace(/[ \t]+$/gm,'');
  const found=stylesheet.indexOf(css,cursor);
  assert(found>=cursor,`Missing or reordered reference style block ${block[1]||'initial'}`);
  cursor=found+css.length;
 }
 assert(cursor<stylesheet.indexOf('/* END APPROVED INDEX.HTML CASCADE */'));
 const finalPalette=blocks.find(block=>block[1].includes('classicfinhub-real-dashboard-blue-theme'))[2];
 for(const declaration of ['--primary:#082c52','--primary2:#0d4f91','--text:#05070a','--bg0:#f7f9fc','--bg1:#eef4fb','--border:#d9e3ef'])assert(finalPalette.includes(declaration),declaration);
 assert.match(stylesheet,/body \*,[\s\S]*font-family:var\(--ui\)!important/,'The final all-UI Inter override must remain');
});

test('native operation and settings dialogs retain their separate approved component geometries',()=>{
 const runtime=stylesheet.split('/* END APPROVED INDEX.HTML CASCADE */')[1];
 assert.match(runtime,/dialog\[data-operation-dialog\][^{]*\{[^}]*width:min\(920px,calc\(100vw - 28px\)\)/);
 assert.match(runtime,/@media\(max-width:900px\)\{dialog\[data-operation-dialog\]\{width:min\(96vw,760px,calc\(100vw - 28px\)\)/);
 assert.match(runtime,/dialog\.workspaceDialog\{[^}]*width:min\(860px,calc\(100vw - 28px\)\)/);
 assert.match(runtime,/#transactionDialog \.formSection\{gap:14px!important;margin:0!important\}/);
 assert.doesNotMatch(runtime,/--primary\s*:|--primary2\s*:|\.navGroup>\.item/,'Runtime adaptations must not redesign the palette or navigation');
 assert.doesNotMatch(stylesheet,/url\(["']?images\//,'Inline image assets must resolve correctly from the external stylesheet');
});
