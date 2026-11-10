'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),ejs=require('ejs'),path=require('node:path');
const {flash,consumeFlash}=require('../src/utils/view');
test('background modal/prepare requests preserve a flash for the actual document',()=>{
 const req={session:{},headers:{}};flash(req,'good','Branch saved.');
 for(const name of ['x-classicfin-background','x-classicfin-prepare']){req.headers={[name]:'true'};assert.equal(consumeFlash(req),null);assert.equal(req.session.flash.message,'Branch saved.');}
 req.headers={};assert.deepEqual(consumeFlash(req),{type:'good',message:'Branch saved.'});assert.equal(consumeFlash(req),undefined);
});
test('shared error and success messages remain accessible and escape submitted content',async()=>{
 for(const type of ['bad','good','info']){
  const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/partials/flash.ejs'),{flash:{type,message:'<img src=x onerror=alert(1)>'}});
  assert.match(html,/data-session-flash/);assert.match(html,new RegExp('role="'+(type==='bad'?'alert':'status')+'"'));assert.match(html,/tabindex="-1"/);assert.match(html,/Dismiss message/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
 }
});
test('activation and reset pages carry visible feedback without putting invitation tokens in markup',async()=>{
 for(const file of ['auth/accept-invite.ejs','auth/accept-staff-invite.ejs','original/reset-password.ejs']){
  const html=await ejs.renderFile(path.resolve(__dirname,'../src/views',file),{flash:{type:'bad',message:'Passwords do not match'},assetVersion:'test',csrfToken:'csrf',slug:'example-office'});
  assert.match(html,/data-feedback-message/);assert.match(html,/Passwords do not match/);assert.match(html,/\/js\/feedback\.js/);assert.match(html,/data-activation-token/);assert.doesNotMatch(html,/name="token" value="[^\"]+/);
 }
});
