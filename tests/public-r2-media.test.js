'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const media=require('../src/tenant/workspace/r2Media');
const sample=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y/9SxoAAAAASUVORK5CYII=','base64');
function text(name){return fs.readFileSync(path.join(__dirname,'..',name),'utf8');}
test('public R2 images are actually validated by signature and pixel dimensions',()=>{
 const valid=media.validateImage(sample,'image/png');
 assert.equal(valid.width,1);assert.equal(valid.height,1);
 assert.equal(valid.sha256.length,64);
 assert.deepEqual(valid.buffer,sample);
 assert.throws(()=>media.validateImage(sample,'image/jpeg'),e=>e.status===415);
 assert.throws(()=>media.validateImage(Buffer.alloc(3*1024*1024+1),'image/png'),e=>e.status===413);
 const huge=Buffer.from(sample);huge.writeUInt32BE(20000,16);
 assert.throws(()=>media.validateImage(huge,'image/png'),e=>e.status===413);
});
test('R2 AWS v4 authorization binds to key, body, region auto and private credentials',()=>{
 const settings={account:'1234567890abcdef1234567890abcdef',access:'EXAMPLEONLY',
  secret:'test-secret-not-live',bucket:'classicfin-public-media',base:'https://images.example.test'};
 const params={method:'PUT',key:'tenants/0123456789abcdef01234567/public/logo/9876543210abcdef12345678.png',
  mime:'image/png',body:sample,date:new Date('2026-11-22T06:00:00Z'),settings};
 const a=media.signature(params),b=media.signature(params);
 assert.deepEqual(a,b);
 assert.match(a.url,/r2\.cloudflarestorage\.com\/classicfin-public-media\/tenants\//);
 assert.match(a.headers.Authorization,/20261122\/auto\/s3\/aws4_request/);
 assert.match(a.headers.Authorization,/SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date/);
 assert.match(a.headers['cache-control'],/immutable/);
 assert.notEqual(media.signature({...params,body:Buffer.from('altered')}).headers.Authorization,a.headers.Authorization);
 assert.doesNotMatch(JSON.stringify(a),/test-secret-not-live/);
});
test('public image routes enforce server auth, CSRF, strict byte handling and ownership',()=>{
 const routes=text('src/tenant/workspace/routes.js'),app=text('src/app.js'),service=text('src/tenant/workspace/service.js'),storage=text('src/tenant/workspace/r2Media.js');
 assert.match(routes,/router\.post\('\/media\/:kind',requirePermission\('workspace\.manage'\),mediaThrottle/);
 assert.match(routes,/express\.raw\(\{type:\['image\/png','image\/jpeg','image\/webp'\],limit:'3mb'\}\)/);
 assert.match(routes,/media\.upload\(req\.tenantDb,req\.tenant,req\.user/);
 assert.match(routes,/media\.remove\(req\.tenantDb,req\.tenant,req\.user/);
 assert.ok(app.indexOf('app.use(csrfProtection)')<app.indexOf("app.use('/tenant'"));
 assert.match(storage,/workspace\.access\(conn,tenant,actor,\{manage:true,session,fence:true\}\)/);
 assert.match(storage,/tenantId:tenant\._id,kind,url,status:'active'/);
 assert.match(service,/require\('\.\/r2Media'\)\.verifyReferences\(conn,tenant,patch\.details,session\)/);
 assert.match(service,/require\('\.\/r2Media'\)\.verifyReferences\(conn,tenant,settings\.landing\.details,session\)/);
});
test('editor uses real file uploads and public links are not underlined',()=>{
 const template=text('src/views/tenant/workspace/form.ejs'),script=text('public/js/workspace.js'),css=text('public/css/business-directory.css');
 assert.match(template,/data-r2-image-kind/);
 assert.match(script,/fetch\('\/tenant\/workspace\/media\/'\+kind/);
 assert.match(script,/x-csrf-token/);
 assert.match(script,/field\.value=result\.url/);
 assert.match(css,/Public-directory interactive text follows/);
 assert.match(css,/\.publicBusinessProfile a[\s\S]*?text-decoration:none/);
 assert.doesNotMatch(template,/data:\/\/|<script/);
});

test('tenant media quota follows active plan snapshot and fails closed for invalid quotas',()=>{
 assert.equal(media.publicMediaQuotaBytes({subscription:{limits:{storageMb:500}}}),500*1024*1024);
 assert.equal(media.publicMediaQuotaBytes({subscription:{limits:{storageMb:0}}}),0);
 assert.equal(media.publicMediaQuotaBytes({}),100*1024*1024);
 assert.equal(media.publicMediaQuotaBytes({subscription:{limits:{storageMb:-10}}}),0);
 assert.equal(media.publicMediaQuotaBytes({subscription:{limits:{storageMb:Infinity}}}),0);
 const s=text('src/tenant/workspace/r2Media.js');
 assert.match(s,/used\.items>=MAX_TENANT_ASSETS/);
 assert.match(s,/used\.bytes\+asset\.buffer\.length>quota/);
 assert.match(s,/\$match:\{tenantId:tenant\._id,status:\{\$in:\['active','deleting'\]\}\}/);
 assert.match(s,/workspace\.access\(conn,tenant,actor,\{manage:true,session,fence:true\}\)/);
});
