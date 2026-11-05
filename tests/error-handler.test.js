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
