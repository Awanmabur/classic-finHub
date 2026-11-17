'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const fs=require('node:fs');
const path=require('node:path');
for(const file of ['fx.ejs','fx-history.ejs','fx-authorizations.ejs']){
 test('cross-currency '+file+' EJS template compiles',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/views/tenant/mobile-money',file),'utf8');
  assert.doesNotThrow(()=>ejs.compile(source,{filename:file}));
 });
}
