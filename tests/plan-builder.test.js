'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const ejs=require('ejs');
const builder=require('../src/platform/services/planBuilder.service');
const commerce=require('../src/platform/services/commercial.service');
const {modules}=require('../src/data/store');
const input=changes=>({code:'custom_manual',name:'Custom Manual',description:'A configurable workspace for manual operations.',priceMonthly:'49.95',priceYearly:'499.50',trialMonths:'1',entryMode:'manual',modules:['mobile_money'],limit_users:'5',limit_branches:'2',limit_transactionsPerMonth:'1000',limit_smsPerMonth:'0',limit_storageMb:'1000',availableForNewTenants:'true',...changes});
test('plan builder parses exact minor units and custom plan codes without converting exponent or fractional limits',()=>{
  const terms=builder.parseForm(input());
  assert.equal(terms.code,'custom_manual');assert.equal(terms.priceMonthlyMinor,4995);assert.equal(terms.priceYearlyMinor,49950);
  assert.equal(terms.availableForNewTenants,true);assert.deepEqual(terms.modules,['mobile_money']);
  for(const changed of [{priceMonthly:'1e3'},{priceYearly:'9.999'},{priceMonthly:'-1'},{limit_users:'0'},{limit_transactionsPerMonth:'1.5'},{modules:['unimplemented']},{modules:['mobile_money','mobile_money']},{code:'../plan'}])assert.throws(()=>builder.parseForm(input(changed)),{status:400});
});
test('draft operations require the platform administrator before any database work',async()=>{
  for(const actor of [null,{id:'staff',permissions:['plans.view']}]){
    await assert.rejects(builder.saveDraft(actor,input()),{status:403});
    await assert.rejects(builder.publishDraft(actor,'custom_manual',{revision:'1',reason:'A reviewed publication for the public catalogue'}),{status:403});
  }
});
test('SMS capture cannot be included in a manual plan or without its capture prerequisites',()=>{
  const terms=builder.parseForm(input());
  assert.throws(()=>commerce.validateNewVersion({...terms,modules:['mobile_money','sms_capture']}),{status:400});
  assert.throws(()=>commerce.validateNewVersion({...terms,entryMode:'sms_assisted',manualPlanCode:'manual_peer',modules:['sms_capture'],limits:{...terms.limits,smsPerMonth:100}}),{status:400});
});
test('plan editor retains escaped values and renders real save/publication actions',async()=>{
  const terms=builder.parseForm(input());
  const values={...builder.formValues(terms),name:'<script>private</script>'};
  const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/platform/plans/editor.ejs'),{csrfToken:'csrf',data:{editor:{values,existing:true,revision:2,baseVersion:1,unpublished:true},values,error:'Review the plan.',manualPlans:[],modules:modules.filter(module=>module.runtimeStatus!=='disabled')}});
  assert.match(html,/action="\/platform\/plans\/custom_manual\/draft"/);
  assert.match(html,/action="\/platform\/plans\/custom_manual\/publish"/);
  assert.match(html,/value="&lt;script&gt;private&lt;\/script&gt;"/);
  assert.doesNotMatch(html,/<script>private/);
  assert.match(html,/name="priceMonthly"/);assert.match(html,/name="limit_smsPerMonth"/);assert.match(html,/name="modules"/);
});
