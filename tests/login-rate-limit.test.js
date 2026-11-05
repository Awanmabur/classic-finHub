'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { login } = require('../src/middleware/rateLimiter');

test('login attempts that redirect (303) are counted, never skipped as successful',async()=>{
  const app=express();
  app.post('/auth',login,(_req,res)=>res.redirect(303,'/signin'));
  const server=await new Promise(resolve=>{ const srv=app.listen(0,()=>resolve(srv)); });
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    for(let i=0;i<100;i++) {
      const response=await fetch(base+'/auth',{method:'POST',redirect:'manual'});
      assert.equal(response.status,303,`attempt ${i+1}`);
    }
    const blocked=await fetch(base+'/auth',{method:'POST',redirect:'manual'});
    assert.equal(blocked.status,429,'101st IP attempt must be throttled');
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});
