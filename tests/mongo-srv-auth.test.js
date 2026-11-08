'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const dns=require('node:dns');
const path=require('node:path');
const {MongoClient}=require('mongoose').mongo;
// Exercise the exact driver instance used by Mongoose, including its real
// SRV/TXT merging, with DNS fully stubbed and no network connections.
const driverEntry=require.resolve('mongodb',{paths:[path.dirname(require.resolve('mongoose'))]});
const {resolveSRVRecord}=require(path.join(path.dirname(driverEntry),'connection_string.js'));
const {resolveMongoConfiguration,tenantUriFromSlug,parseMongoUri}=require('../src/config/mongoUris');
const scheme=['mongodb','srv'].join('+');
const uri=(database,query='')=>`${scheme}://unit-user:unit-only-not-a-credential@cluster.example/${database}${query?'?'+query:''}`;

function mockDns(t,txt){
 t.mock.method(dns.promises,'resolveSrv',async hostname=>{
  assert.equal(hostname,'_mongodb._tcp.cluster.example');
  return [{name:'db1.cluster.example',port:27017,priority:0,weight:0}];
 });
 t.mock.method(dns.promises,'resolveTxt',async hostname=>{
  assert.equal(hostname,'cluster.example');
  if(txt===null)throw Object.assign(new Error('No synthetic TXT record'),{code:'ENODATA'});
  return [[txt]];
 });
}

test('implicit SRV authentication resolves the named platform and empty base through DNS TXT',async t=>{
 mockDns(t,'authSource=admin&replicaSet=unit-rs');
 const platform=new MongoClient(uri('platform_DB')),base=new MongoClient(uri(''));
 assert.equal(platform.options.credentials.source,'platform_DB');
 assert.equal(base.options.credentials.source,'admin');
 assert.equal(platform.options.userSpecifiedAuthSource,false);
 assert.equal(base.options.userSpecifiedAuthSource,false);
 await resolveSRVRecord(platform.options);
 await resolveSRVRecord(base.options);
 assert.equal(platform.options.credentials.source,'admin');
 assert.equal(base.options.credentials.source,'admin');
 assert.equal(platform.options.replicaSet,'unit-rs');
});

test('tenant links pin the actual TXT authentication database rather than assume admin',async t=>{
 mockDns(t,'authSource=custom_auth_db');
 const input={PLATFORM_DB_URI:uri('platform_DB','appName=platform'),MONGO_URI_BASE:uri('','appName=tenant')};
 assert.equal(resolveMongoConfiguration(input).mongoPlatformUri,input.PLATFORM_DB_URI,'configuration must retain implicit TXT semantics');
 const platform=new MongoClient(input.PLATFORM_DB_URI);
 await resolveSRVRecord(platform.options);
 assert.equal(platform.options.credentials.source,'custom_auth_db');
 const link=tenantUriFromSlug('tenant-one',input,{resolvedAuthSource:platform.options.credentials.source});
 const parsed=parseMongoUri(link),tenant=new MongoClient(link);
 assert.equal(parsed.explicitAuthSource,true);
 assert.equal(parsed.query.get('appName'),'tenant');
 assert.equal(tenant.options.dbName,'classicfin_tenant_tenant_one_db');
 assert.equal(tenant.options.credentials.source,'custom_auth_db');
 assert.equal(tenant.options.userSpecifiedAuthSource,true);
 await resolveSRVRecord(tenant.options);
 assert.equal(tenant.options.credentials.source,'custom_auth_db');
});

test('without TXT, tenant links retain platform authentication instead of the empty base default',async t=>{
 mockDns(t,null);
 const input={PLATFORM_DB_URI:uri('platform_DB'),MONGO_URI_BASE:uri('')};
 const platform=new MongoClient(input.PLATFORM_DB_URI),base=new MongoClient(input.MONGO_URI_BASE);
 await resolveSRVRecord(platform.options);
 await resolveSRVRecord(base.options);
 assert.equal(platform.options.credentials.source,'platform_DB');
 assert.equal(base.options.credentials.source,'admin','the empty base is not the runtime authentication authority');
 const tenant=new MongoClient(tenantUriFromSlug('tenant-one',input,{resolvedAuthSource:platform.options.credentials.source}));
 assert.equal(tenant.options.credentials.source,'platform_DB');
 assert.equal(tenant.options.userSpecifiedAuthSource,true);
 await resolveSRVRecord(tenant.options);
 assert.equal(tenant.options.credentials.source,'platform_DB');
});

test('explicit authentication remains authoritative over conflicting TXT or resolved-link hints',async t=>{
 mockDns(t,'authSource=other_auth_db');
 const input={PLATFORM_DB_URI:uri('platform_DB','authSource=explicit_auth_db'),MONGO_URI_BASE:uri('','authSource=explicit_auth_db')};
 const platform=new MongoClient(input.PLATFORM_DB_URI);
 await resolveSRVRecord(platform.options);
 assert.equal(platform.options.credentials.source,'explicit_auth_db');
 const tenant=new MongoClient(tenantUriFromSlug('tenant-one',input,{resolvedAuthSource:'untrusted_other_hint'}));
 assert.equal(tenant.options.credentials.source,'explicit_auth_db');
 await resolveSRVRecord(tenant.options);
 assert.equal(tenant.options.credentials.source,'explicit_auth_db');
});
