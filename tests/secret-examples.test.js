'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {scanText}=require('../scripts/check-secret-examples');
function atlas(user,password){return ['mongodb','+srv://',user,':',password,'@','cluster','.mongodb.net','/platform?retryWrites=true'].join('');}
test('Atlas examples are rejected even when the password is labelled as a placeholder',()=>{
 for(const value of [atlas('example_user','ENCODED_PASSWORD'),atlas('web','not-a-real-test-password'),atlas('a%40b','p%3Assword')])assert.deepEqual(scanText('\nMONGO_PLATFORM_URI='+value),[{line:2,kind:'credential-shaped-atlas-uri'}]);
});
test('scanner reports only location and type, without repeating credentials',()=>{
 const password='private-test-value',value=atlas('private-user',password),output=JSON.stringify(scanText(value));
 assert(!output.includes(password));assert(!output.includes('private-user'));assert(!output.includes(value));
});
test('blank private-config slots and unauthenticated local development URIs remain usable',()=>{
 for(const value of ['MONGO_PLATFORM_URI=\nPLATFORM_DB_URI=\nMONGO_URI_BASE=','mongodb://127.0.0.1:27018/platform?replicaSet=rs0','Use Atlas Connect to copy your URI into the private environment.'])assert.deepEqual(scanText(value),[]);
});
