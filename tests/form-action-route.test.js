'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const origin='https://classicfinhub.com',target='/tenant/treasury/accounts/507f1f77bcf86cd799439012/record';
test('feedback resolves a form action ATTRIBUTE even if a select shadows form.action',()=>{
 const source=read('public/js/feedback.js');
 const match=source.match(/const action=new URL\(([\s\S]*?)\);/);
 assert(match,'The submission handler must resolve a real action URL');
 const resolve=(form,submitter=null)=>vm.runInNewContext(
  'const action=new URL('+match[1]+'); action.pathname;',
  {form,event:{submitter},location:{origin,href:origin+'/tenant/treasury'},URL});
 const form={
  action:{toString(){return '[object HTMLSelectElement]';}},
  getAttribute(name){return name==='action'?target:null;}
 };
 assert.equal(resolve(form),target);
 assert.equal(resolve(form,{getAttribute:name=>name==='formaction'?'/tenant/treasury/funding':null}),
  '/tenant/treasury/funding','Button-specific action overrides only the real form attribute');
 assert.notEqual(resolve(form),'/[object%20HTMLSelectElement]');
});
test('all browser financial/form dispatch paths avoid shadowable form.action',()=>{
 for(const file of ['public/js/feedback.js','public/js/offline-workspace.js','public/js/branches.js','public/js/dashboard.js']){
  const source=read(file);
  const executable=source.split('\n').filter(line=>!line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(executable,/\b(?:form|present)\.action\b/,file+' uses HTMLFormElement.action, which may be a named child');
 }
 assert.match(read('src/views/tenant/treasury/detail.ejs'),/name="recordAction"/);
 assert.doesNotMatch(read('src/views/tenant/treasury/detail.ejs'),/name="action"/);
 assert.match(read('src/tenant/treasury/routes.js'),/req\.body\.recordAction\|\|req\.body\.action/,'Older forms must be accepted during upgrade');
});
