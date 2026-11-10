'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),ejs=require('ejs'),path=require('node:path'),vm=require('node:vm'),fs=require('node:fs');
const {pricingForm}=require('../src/tenant/workspace/routes');
const branch={_id:'507f1f77bcf86cd799439011',name:'Main',currency:'USD',currencies:['USD','SSP'],status:'active'};
const rule={_id:'507f1f77bcf86cd799439012',revision:4,operation:'money_transfer.send',currency:'USD',network:'',branchId:null,fixedFeeMinor:'125',feeBps:200,fixedCostMinor:'10',costBps:50,enabled:true};
function preview({rules=[rule],operation='money_transfer.send',currency='USD',amount='100.05',rate,kind}={}){
 const listeners={},messages=Object.fromEntries(['[data-pricing-fee]','[data-pricing-cost]','[data-pricing-label]'].map(key=>[key,{textContent:''}]));
 const host={dataset:{pricingContext:JSON.stringify({rules,branchId:branch._id,operation,field:operation.startsWith('forex.')?'commission':'fee'})},querySelector:key=>messages[key]};
 const controls={amount:{value:amount},currency:{value:currency},fee:{value:'0'},commission:{value:'0'},pricingPolicy:{value:'default'},...(rate?{rateId:{selectedOptions:[{dataset:rate}]}}:{}),...(kind?{kind:{value:kind}}:{})};
 const form={dataset:{currency,operation:'cash_in'},querySelector:key=>key==='[data-pricing-context]'?host:null,elements:{namedItem:name=>controls[name]},addEventListener:(event,handler)=>(listeners[event]||=[]).push(handler)};
 for(const control of Object.values(controls))control.dispatchEvent=event=>{for(const listener of listeners[event.type]||[])listener({target:control});};
 const context={window:{},document:{querySelectorAll:()=>[form]},Event,queueMicrotask};vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../public/js/operation-pricing.js'),'utf8'),context);
 return {controls,messages,form,refresh:()=>context.window.ClassicFinPricing.initialise(form)};
}
test('price preview calculates exact fixed plus percentage and separate cost without network requests',()=>{
 const value=preview();assert.equal(value.controls.fee.value,'3.25');assert.equal(value.controls.pricingPolicy.value,rule._id+':4');assert.equal(value.messages['[data-pricing-fee]'].textContent,'USD 3.25');assert.equal(value.messages['[data-pricing-cost]'].textContent,'USD 0.60');
 value.controls.amount.value='0.25';value.refresh();assert.equal(value.controls.fee.value,'1.26','half-cent percentage rounds half up once');
 value.controls.currency.value='SSP';value.refresh();assert.equal(value.controls.fee.value,'0.00');assert.equal(value.controls.pricingPolicy.value,'default');
});
test('branch and network precedence matches the authoritative pricing selector',()=>{
 const rules=[{...rule,operation:'mobile_money.cash_in',network:'MTN',fixedFeeMinor:'900'},{...rule,_id:'507f1f77bcf86cd799439013',operation:'mobile_money.cash_in',branchId:branch._id,fixedFeeMinor:'200',feeBps:0}];
 const value=preview({rules,operation:'mobile_money.cash_in'});assert.equal(value.controls.fee.value,'2.00');assert.equal(value.controls.pricingPolicy.value,rules[1]._id+':4');
 value.form.dataset.operation='cash_out';value.refresh();assert.equal(value.controls.fee.value,'0.00');assert.equal(value.controls.pricingPolicy.value,'default');
});
test('forex preview applies commission to the rounded settlement amount rather than foreign principal',()=>{
 const value=preview({operation:'forex.buy',rules:[{...rule,operation:'forex.buy',currency:'SSP',fixedFeeMinor:'100',feeBps:200,fixedCostMinor:'0',costBps:50}],amount:'10',rate:{from:'USD',to:'SSP',rate:'100'}});
 assert.equal(value.controls.commission.value,'21.00');assert.equal(value.messages['[data-pricing-cost]'].textContent,'SSP 5.00');
});
test('minimal transfer preserves controls and puts optional identity details behind one disclosure',async()=>{
 const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/tenant/money-transfer/_entry-form.ejs'),{currentBranch:branch,data:{destinationBranches:[{...branch,_id:'507f1f77bcf86cd799439099',name:'Receiving'}],currencyChoices:[{code:'USD',label:'USD'}],selectedCurrency:'USD',idempotencyKey:'reference',pricingContext:[rule]}});
 assert.match(html,/name="senderName" required/);assert.match(html,/name="receiverName" required/);assert.match(html,/name="destinationBranchId" required/);assert.match(html,/name="fee" value="0"/);assert.match(html,/name="pricingMode" value="configured"/);assert.match(html,new RegExp('name="pricingPolicy" value="'+rule._id+':4"'));assert.match(html,/<details[^>]*><summary>Additional details<\/summary>[\s\S]*name="senderDocument"/);assert.doesNotMatch(html,/<input[^>]*name="fee"[^>]*class="control"/);assert.doesNotMatch(html,/<select[^>]*name="validDays"/);assert.match(html,/Estimated operating cost/);
});
test('pricing edit freezes scope, carries revision, and new tenant defaults do not become required blank choices',async()=>{
 const context={rules:[rule],branches:[branch],operations:[{key:'money_transfer.send',label:'Send money'}]};
 const edit=pricingForm(context,rule);assert.equal(edit.revision,4);assert.equal(edit.action,'/tenant/workspace/pricing/'+rule._id);assert.deepEqual(edit.hidden.find(field=>field.name==='id'),{name:'id',value:rule._id});assert(edit.fields.filter(field=>field.displayOnly).every(field=>!field.required));
 const create=pricingForm(context);assert.equal(create.fields.find(field=>field.name==='branchId').required,false);assert.equal(create.fields.find(field=>field.name==='network').required,false);
 const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/tenant/workspace/form.ejs'),{csrfToken:'safe',form:create});assert.match(html,/<select[^>]*name="branchId"\s*>/);assert.match(html,/<option value="" selected>All branches/);
});
