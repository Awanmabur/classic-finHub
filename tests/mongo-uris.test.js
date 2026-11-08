'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {resolveMongoConfiguration,tenantUriFromSlug}=require('../src/config/mongoUris');
const local=(database='platform',options='replicaSet=rs0')=>`mongodb://db-a:27017,db-b:27017/${database}?${options}`;
function authenticated(database,options=''){
 const scheme=['mongodb','srv'].join('+');
 return `${scheme}://web-unit:unit-only-password@cluster.example/${database}?authSource=admin${options?'&'+options:''}`;
}
test('platform alias and optional empty base preserve safe tenant database derivation',()=>{
 const input={NODE_ENV:'production',PLATFORM_DB_URI:local('platform_DB','replicaSet=rs0&appName=platform'),MONGO_URI_BASE:local('','replicaSet=rs0&appName=tenant')};
 assert.equal(resolveMongoConfiguration(input).mongoPlatformUri,input.PLATFORM_DB_URI);
 assert.match(tenantUriFromSlug('tenant-one',input),/\/classicfin_tenant_tenant_one_db\?replicaSet=rs0&appName=tenant$/);
 assert.notEqual(tenantUriFromSlug('tenant-one',input),tenantUriFromSlug('tenant-two',input));
 assert.throws(()=>tenantUriFromSlug('../../platform',input),/Invalid tenant slug/);
 assert.throws(()=>tenantUriFromSlug('tenant-one',{PLATFORM_DB_URI:local('classicfin_tenant_tenant_one_db')}),/must be distinct/);
});
test('equivalent aliases accept query ordering, host ordering and harmless appName differences',()=>{
 const original=local('platform','replicaSet=rs0&retryWrites=true&appName=primary');
 const alias='mongodb://db-b:27017,db-a:27017/platform?appName=alias&retryWrites=true&replicaSet=rs0';
 assert.equal(resolveMongoConfiguration({MONGO_PLATFORM_URI:original,PLATFORM_DB_URI:alias}).mongoPlatformUri,original);
 assert.throws(()=>resolveMongoConfiguration({MONGO_PLATFORM_URI:original,PLATFORM_DB_URI:local('other')}),/conflict/);
});
test('base URI cannot silently redirect tenant writes or weaken platform security settings',()=>{
 const input={PLATFORM_DB_URI:authenticated('platform','tls=true&w=majority&retryWrites=true'),MONGO_URI_BASE:authenticated('','retryWrites=true&w=majority&tls=true')};
 assert(resolveMongoConfiguration(input));
 for(const base of [authenticated('tenant'),authenticated('').replace('web-unit','other-user'),authenticated('').replace('unit-only-password','different-password'),authenticated('').replace('cluster.example','elsewhere.example'),authenticated('','tls=false'),authenticated('').replace('authSource=admin','authSource=other'),authenticated('').replace('?authSource=admin','')]){
  assert.throws(()=>resolveMongoConfiguration({...input,MONGO_URI_BASE:base}),error=>!error.message.includes('unit-only-password')&&!error.message.includes(base));
 }
 assert.throws(()=>resolveMongoConfiguration({PLATFORM_DB_URI:authenticated('platform').replace('?authSource=admin',''),MONGO_URI_BASE:authenticated('')}),/same authSource/);
 for(const option of ['tlsAllowInvalidHostnames','tlsAllowInvalidCertificates','tlsInsecure'])assert.throws(()=>resolveMongoConfiguration({PLATFORM_DB_URI:local('platform','tls=true'),MONGO_URI_BASE:local('','tls=true&'+option+'=true')}),/must match/);
});
test('database names, production storage and malformed driver settings fail without credential disclosure',()=>{
 for(const input of [{NODE_ENV:'production'},{NODE_ENV:'production',PLATFORM_DB_URI:local('')},{PLATFORM_DB_URI:'mongodb://bad:DO-NOT-LEAK@host/platform?unsupportedOption=true'},{PLATFORM_DB_URI:'mongodb://host/path%2Fother'},{PLATFORM_DB_URI:'not-a-uri'}]){
  assert.throws(()=>resolveMongoConfiguration(input),error=>!error.message.includes('DO-NOT-LEAK'));
 }
 assert.equal(resolveMongoConfiguration({}).mongoUriBase,null);
 assert.throws(()=>tenantUriFromSlug('tenant-one',{PLATFORM_DB_URI:authenticated('platform').replace('?authSource=admin','')}),/Connect to platform MongoDB/);
});

test('standard SRV platform/base pairs accept DNS authentication defaults without weakening identity checks',()=>{
 const platform=authenticated('platform').replace('?authSource=admin','?appName=platform');
 const base=authenticated('').replace('?authSource=admin','?appName=tenant');
 const input={PLATFORM_DB_URI:platform,MONGO_URI_BASE:base};
 assert.equal(resolveMongoConfiguration(input).mongoPlatformUri,platform);
 assert.equal(resolveMongoConfiguration(input).mongoUriBase,base);
 for(const candidate of [base.replace('web-unit','other-user'),base.replace('unit-only-password','other-password'),base.replace('cluster.example','elsewhere.example'),base+'&tls=false',base+'&retryWrites=false']){
  assert.throws(()=>resolveMongoConfiguration({...input,MONGO_URI_BASE:candidate}),/must match/);
 }
 assert.throws(()=>resolveMongoConfiguration({...input,MONGO_URI_BASE:base+'&authSource=admin'}),/same authSource/);
 assert.throws(()=>resolveMongoConfiguration({PLATFORM_DB_URI:platform+'&authSource=admin',MONGO_URI_BASE:base}),/same authSource/);
 assert.throws(()=>resolveMongoConfiguration({PLATFORM_DB_URI:platform.replace('mongodb+srv','mongodb'),MONGO_URI_BASE:base.replace('mongodb+srv','mongodb')}),/same authSource/);
});

test('derived tenant links pin resolved SRV authSource, including non-admin TXT and no-TXT fallback',()=>{
 const platform=authenticated('platform').replace('?authSource=admin','?appName=platform');
 const base=authenticated('').replace('?authSource=admin','?appName=tenant');
 for(const input of [{PLATFORM_DB_URI:platform,MONGO_URI_BASE:base},{PLATFORM_DB_URI:platform}]){
  assert.throws(()=>tenantUriFromSlug('tenant-one',input),/Connect to platform MongoDB/);
  for(const source of ['admin','custom_auth','platform']){
   const link=tenantUriFromSlug('tenant-one',input,{resolvedAuthSource:source}),query=new URLSearchParams(link.split('?')[1]);
   assert.equal(query.get('authSource'),source);assert.match(link,/\/classicfin_tenant_tenant_one_db\?/);
  }
 }
 const direct=platform.replace('mongodb+srv','mongodb');
 assert.equal(new URLSearchParams(tenantUriFromSlug('tenant-one',{PLATFORM_DB_URI:direct}).split('?')[1]).get('authSource'),'platform');
});
