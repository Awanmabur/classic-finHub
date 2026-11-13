'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const path = require('node:path');
const {checkPayload} = require('../src/platform/services/tenantProvisioning.service');
const {tenantDbNameFromSlug} = require('../src/config/tenantDatabaseName');
const Tenant = require('../src/platform/models/Tenant');
const payload = (changes={}) => ({name:'Acme Finance',slug:'acme-finance',owner:'Owner Name',email:'owner@example.invalid',phone:'+256 700 000 123',plan:'modular',...changes});

test('tenant creation preserves contact details and normalizes uppercase slugs and email',()=>{
  const result=checkPayload(payload({slug:'  Acme-Finance ',email:' Owner@Example.Invalid '}));
  assert.equal(result.slug,'acme-finance');
  assert.equal(result.email,'owner@example.invalid');
  assert.equal(result.phone,'+256 700 000 123');
  assert.deepEqual(result.enabledModules,[]);
});
test('generated and explicit slugs fit the MongoDB database-name limit',()=>{
  const generated=checkPayload(payload({slug:'',name:'A'.repeat(150)}));
  assert.equal(generated.slug.length,17);
  assert.equal(Buffer.byteLength(tenantDbNameFromSlug(generated.slug)),38);
  assert.equal(checkPayload(payload({slug:'a'.repeat(17)})).slug.length,17);
  assert.throws(()=>checkPayload(payload({slug:'a'.repeat(18)})),{status:400});
  assert.throws(()=>checkPayload(payload({slug:'a'.repeat(42)})),{status:400});
  assert.throws(()=>tenantDbNameFromSlug('a'.repeat(43)));
  const tenant=new Tenant({name:'Acme',slug:'a'.repeat(43),dbName:'unused',email:'a@example.invalid',plan:'modular',status:'trial'});
  assert(tenant.validateSync().errors.slug);
  for(const slug of ['../admin','a','bad.slug','/tenant'])assert.throws(()=>checkPayload(payload({slug})),{status:400});
});
test('provisioning rejects owner details that cannot activate or be updated',()=>{
  for(const changes of [{owner:'a'.repeat(121)},{email:'a'.repeat(250)+'@test.invalid'},{phone:'a'},{phone:'1'.repeat(41)},{plan:'bad/code'}]){
    assert.throws(()=>checkPayload(payload(changes)),{status:400});
  }
  assert.equal(checkPayload(payload({owner:'a'.repeat(120),phone:''})).owner.length,120);
});
test('tenant create form escapes retained values and presents validation feedback',async()=>{
  const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/platform/tenants/create.ejs'),{
    csrfToken:'csrf',data:{plans:[{code:'modular',name:'Published Workspace'}],error:'Choose a different slug.',values:{name:'<script>alert(1)</script>',plan:'modular',phone:'+256 700'}}
  });
  assert.match(html,/role="alert"/);
  assert.match(html,/Choose a different slug/);
  assert.match(html,/value="&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>/);
  assert.match(html,/Published Workspace/);
  assert.match(html,/value="modular" selected/);
  assert.match(html,/maxlength="17"/);
  assert.match(html,/value="\+256 700"/);
});
test('empty catalogue offers an administrator setup action instead of an unusable create form',async()=>{
  const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/platform/tenants/create.ejs'),{
    csrfToken:'setup-csrf',data:{plans:[],catalogueEmpty:true,error:null,values:{}}
  });
  assert.match(html,/<form[^>]+method="post"[^>]+action="\/platform\/plans\/publish-initial"/);
  assert.match(html,/name="_csrf" value="setup-csrf"/);
  assert.doesNotMatch(html,/<form[^>]+action="\/platform\/tenants"/);
  assert.doesNotMatch(html,/<select[^>]+name="plan"/);
  assert.doesNotMatch(html,/<button[^>]+disabled/,'setup action is usable');
});
test('unavailable published plans explain the block without suggesting reinitialization',async()=>{
  const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/platform/tenants/create.ejs'),{
    csrfToken:'csrf',data:{plans:[],catalogueEmpty:false,error:null,values:{}}
  });
  assert.match(html,/available for new tenants/i);
  assert.match(html,/href="\/platform\/plans"/);
  assert.doesNotMatch(html,/action="\/platform\/plans\/publish-initial"/);
  assert.doesNotMatch(html,/<form[^>]+action="\/platform\/tenants"/);
  assert.doesNotMatch(html,/<select[^>]+name="plan"/);
});
