'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const ejs=require('ejs');
const service=require('../src/tenant/workspace/service');
const routes=require('../src/tenant/workspace/routes');
const tenant={_id:'507f1f77bcf86cd799439011',slug:'workspace-example',dbName:'classicfin_tenant_workspace_example_db',name:'Example business',owner:'Owner',email:'owner@example.invalid'};
const owner={id:'507f1f77bcf86cd799439012',role:'Tenant Owner',permissions:['*']};
const profile={name:'Example business',legalName:'Example Limited',owner:'Director',ownerEmail:'OWNER@example.invalid',supportPhone:'+256 700 123456',country:'Uganda',timezone:'Africa/Kampala',defaultCurrency:'UGX'};

test('workspace settings reject privilege and routing fields rather than accepting arbitrary tenant changes',async()=>{
 for(const field of ['subscription','dbName','status','allowedModules','permissions','slug','customDomain'])assert.throws(()=>service.validateConfig('profile',{...profile,[field]:'forged'}),{status:400});
 assert.equal(service.validateConfig('profile',profile).ownerEmail,'owner@example.invalid');
 assert.throws(()=>service.validateConfig('profile',{...profile,timezone:'Not/A-Timezone'}),{status:400});
 assert.throws(()=>service.validateConfig('profile',{...profile,defaultCurrency:'KSH'}),{status:400});
 for(const currency of ['UGX','USD','SSP','KES'])assert.equal(service.validateConfig('profile',{...profile,defaultCurrency:currency}).defaultCurrency,currency);
 await assert.rejects(service.read({name:'classicfin_tenant_other_db'},tenant,owner),{status:403});
 await assert.rejects(service.publicLanding({name:'classicfin_tenant_other_db'},tenant),{status:403});
});

test('integration settings cannot store credentials or claim a verified connection',()=>{
 for(const secret of ['API key: sensitive','secret = sensitive','Bearer abcdefghijklmnop','-----BEGIN PRIVATE KEY-----'])assert.throws(()=>service.validateEntry('integration',{name:'Gateway',type:'Webhook',status:'enabled',description:secret}),{status:400});
 assert.throws(()=>service.validateEntry('integration',{name:'Gateway',type:'Webhook',status:'connected',description:'Gateway connection description'}),{status:400});
 assert.equal(service.validateEntry('integration',{name:'Android gateway',type:'Messaging',status:'draft',description:'Device enrollment is configured in SMS capture.'}).status,'draft');
 assert.throws(()=>service.validateEntry('data_job',{name:'Injected finished job',type:'CSV',status:'completed',records:'999'}),{status:400});
});

test('workspace form revisions and controlled entry choices reject ambiguous requests',()=>{
 for(const value of ['-1','1.0','01','Infinity',{},[],1.25])assert.throws(()=>service.revision(value),{status:409});
 assert.equal(service.revision('0'),0);
 assert.throws(()=>service.validateEntry('kyc_field',{name:'Identity',type:'Select',required:'true',status:'enabled',options:''}),{status:400});
 assert.throws(()=>service.validateEntry('landing_section',{name:'Terms',description:'Terms text',status:'published',order:'1001'}),{status:400});
 assert.throws(()=>service.validateConfig('branding',{theme:'Default',primary:'#000000;body{}',secondary:'#ffffff',prefix:'CFH',template:'Default'}),{status:400});
});

test('approved profile and receipt forms preserve read-only controls and submit all required brand fields',async()=>{
 const config=service.defaults(tenant);
 const profileForm=routes.configForm('profile',config,tenant);
 assert.deepEqual(profileForm.fields.map(f=>f.label),['Business name','Legal name','Owner / director','Owner email','Support phone','Subdomain','Custom domain','Country','Timezone','Default currency']);
 const receipt=routes.configForm('receipt',config,tenant);
 assert.equal(receipt.title,'Edit receipt settings');
 assert.deepEqual(receipt.fields.map(f=>f.label),['Receipt prefix','Template name','QR verification','Duplicate protection','Receipt note']);
 const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/tenant/workspace/form.ejs'),{form:receipt,csrfToken:'csrf'});
 assert.match(html,/name="primary" value="#082c52"/);assert.match(html,/name="secondary" value="#0d4f91"/);
 assert.match(html,/name="prefix"/);
 assert.doesNotMatch(html,/name="qrVerification"|name="duplicateProtection"/);
 assert.match(html,/Save changes/);
});

test('saved receipt wording is escaped while immutable transaction references remain intact',async()=>{
 const record={_id:'507f1f77bcf86cd799439013',operation:'cash_in',createdAt:new Date(),network:'MTN',networkReference:'ORIGINAL-NETWORK-123',customer:'Customer',status:'pending_verification',reviewState:'awaiting_review',correctionState:'none'};
 const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/tenant/mobile-money/acknowledgement.ejs'),{record,reference:'CFH-ACK-IMMUTABLE',amount:'UGX 1,000',fee:'UGX 0',identity:{name:'<script>unsafe()</script>',template:'Standard',supportPhone:'+256700123456',footerNote:'<img src=x onerror=alert(1)>'}});
 assert.match(html,/CFH-ACK-IMMUTABLE/);assert.match(html,/ORIGINAL-NETWORK-123/);
 assert.doesNotMatch(html,/<script>unsafe|<img src=x/);assert.match(html,/&lt;script&gt;unsafe/);assert.match(html,/NOT PROOF OF PAYMENT OR SETTLEMENT/);
 const csv=service.auditCsv([{createdAt:new Date('2026-11-06'),action:'=HYPERLINK("unsafe")',actorId:'actor',targetId:'target'}]);
 assert.match(csv,/"'=HYPERLINK/);
});


test('tenant profile explains wallet setup without adding setup fields to daily transactions',async()=>{
 const config=service.defaults(tenant);
 const data={page:'profile',config,canManage:false,spec:null,canCash:true,canObserveFunds:true,canReviewFunds:true};
 const template=path.resolve(__dirname,'../src/views/tenant/workspace/index.ejs');
 const html=await ejs.renderFile(template,{data,tenant,user:owner,assetVersion:'test',csrfToken:'csrf'});
 assert.match(html,/Wallets &amp; daily operations/);assert.match(html,/Set up once/);assert.match(html,/Choose defaults/);assert.match(html,/href="\/tenant\/treasury#add-funds"/);assert.match(html,/href="\/tenant\/treasury\/review"/);
 assert.doesNotMatch(html,/name="(?:walletAccountId|observedWalletBalance|feeTreatment)"/,'profile guides account setup without embedding a transaction form');
 data.canObserveFunds=false;data.canReviewFunds=false;
 const readOnly=await ejs.renderFile(template,{data,tenant,user:owner,assetVersion:'test',csrfToken:'csrf'});
 assert.doesNotMatch(readOnly,/href="\/tenant\/treasury(?:#add-funds|\/review)"/);
 data.canCash=false;
 const noSource=await ejs.renderFile(template,{data,tenant,user:owner,assetVersion:'test',csrfToken:'csrf'});
 assert.doesNotMatch(noSource,/workspaceOperationsTitle|Wallets &amp; daily operations/);
});
