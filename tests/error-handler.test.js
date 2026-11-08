'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const errorHandler = require('../src/middleware/errorHandler');

test('malformed JSON is rejected without echoing or logging credential contents', async () => {
  const logs = [];
  const originalError = console.error;
  console.error = entry => logs.push(entry);
  const app = express();
  app.use(express.json());
  app.post('/signin', (_req, res) => res.sendStatus(204));
  app.use(errorHandler);
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, () => resolve(listener));
      listener.once('error', reject);
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/signin`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'token=private-activation-secret'
    });
    assert.equal(response.status, 400);
    assert.equal(await response.text(), 'The request body must contain valid JSON.');
    assert.equal(logs.length, 1);
    assert.equal(JSON.parse(logs[0]).reason, 'invalid_json');
    assert.doesNotMatch(logs.join('\n'), /private|activation|secret|token=/);
  } finally {
    console.error = originalError;
    if (server) await new Promise(resolve => server.close(resolve));
  }
});

test('internal failures log a safe classification and preserve generic client errors', () => {
  const logs = [];
  const originalError = console.error;
  console.error = entry => logs.push(entry);
  const response = { status(value) { this.statusCode=value;return this; }, type(){return this;}, send(value){this.body=value;return this;} };
  try {
    errorHandler(new Error('Database uri contains a private-value'), { path:'/signin', requestId:'test' }, response, () => assert.fail('Unexpected next'));
    assert.equal(response.statusCode, 500);
    assert.equal(response.body, 'An unexpected error occurred. Please try again later.');
    assert.equal(JSON.parse(logs[0]).reason, 'internal_error');
    assert.doesNotMatch(logs.join('\n'), /private-value|Database uri/);
  } finally { console.error=originalError; }
});

test('internal failures have a traceable reference and source without logging exception data',()=>{
 const path=require('node:path'),logs=[],originalError=console.error;console.error=row=>logs.push(JSON.parse(row));
 const reference='73b1045c-9b9c-4c7e-8494-819a8dffcc31',headers={},response={status(value){this.statusCode=value;return this;},type(){return this;},setHeader(name,value){headers[name]=value;},send(value){this.body=value;return this;}};
 try{const error=new ReferenceError('private-password-and-customer-data');error.code='PRIVATE_SECRET_TOKEN';error.stack='ReferenceError: private-password-and-customer-data\n    at example ('+path.resolve(__dirname,'../src/tenant/routes/index.js')+':42:3)';errorHandler(error,{path:'/tenant/dashboard',requestId:reference},response,()=>assert.fail());assert.equal(response.statusCode,500);assert.match(response.body,new RegExp(reference));assert.equal(headers['X-Error-Reference'],reference);assert.equal(logs[0].source,'src/tenant/routes/index.js:42');assert.equal(logs[0].errorCode,'APPLICATION_ERROR');assert.equal(logs[0].errorType,'ReferenceError');assert.doesNotMatch(JSON.stringify(logs),/private-password|PRIVATE_SECRET_TOKEN/);}finally{console.error=originalError;}
});
test('sign-in key configuration failures explain the required recovery without exposing keys',()=>{const originalError=console.error;console.error=()=>{};try{for(const code of ['MFA_KEY_MISSING','MFA_SECRET_UNAVAILABLE']){const response={status(value){this.statusCode=value;return this;},type(){return this;},send(value){this.body=value;return this;}};errorHandler(Object.assign(Error('secret ciphertext should not appear'),{status:503,code}),{path:'/mfa/challenge'},response,()=>assert.fail());assert.equal(response.statusCode,503);assert.match(response.body,/authenticator encryption key/);assert.doesNotMatch(response.body,/secret ciphertext|unexpected/);}}finally{console.error=originalError;}});
