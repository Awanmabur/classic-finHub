'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ejs=require('ejs');
const code=fs.readFileSync(path.resolve(__dirname,'../public/js/dashboard.js'),'utf8');
function element(extra={}){
  const handlers={};
  return {hidden:false,disabled:false,required:false,dataset:{},value:'',textContent:'',
    addEventListener(name,fn){(handlers[name]||=[]).push(fn);},
    emit(name,event={}){for(const fn of handlers[name]||[])fn(event);},
    setCustomValidity(message){this.validationMessage=message;},reportValidity(){return !this.validationMessage;},
    ...extra};
}
function option(value,dataset={}){return {value,dataset,disabled:false,hidden:false};}
function select(options,value=options[0]?.value||''){
  const control=element({options,tagName:'SELECT'});let selected=value;
  Object.defineProperties(control,{value:{get:()=>selected,set:value=>{selected=options.some(option=>option.value===value)?value:'';}},selectedOptions:{get:()=>options.filter(option=>option.value===selected)}});
  return control;
}
function form(mode,fields,targets,selects=[]){
  return element({elements:{namedItem:name=>fields[name]||null},
    matches:selector=>selector.includes('form:has([data-account-currency])')&&mode==='banking'||selector.includes('[data-transfer-form]')&&mode==='transfer'||selector.includes('[data-forex-form]')&&mode==='forex',
    querySelector:selector=>targets[selector]||null,
    querySelectorAll:selector=>selector==='select:has([data-account-currency])'?selects:selector==='select[data-forex-currency]'?selects:[]});
}
function run({operations=[],funding=[]}){
  const document={body:{dataset:{},classList:{toggle(){}}},getElementById:()=>null,querySelector:()=>null,addEventListener(){},
    querySelectorAll:selector=>selector==='[data-transfer-form],[data-forex-form],form:has([data-account-currency])'?operations:selector==='[data-wallet-funding-form]'?funding:[]};
  vm.runInNewContext(code,{document,window:{matchMedia:()=>({matches:false,addEventListener(){}}),addEventListener(){}},queueMicrotask});
}

test('banking choices follow operation and currency while rejecting identical account selections',()=>{
  const currency=select([option('USD'),option('UGX'),option('SSP')]);
  const kind=select(['deposit_request','withdrawal_request','transfer_request'].map(value=>option(value)));
  const accounts=()=>[option(''),option('one',{accountCurrency:'USD'}),option('two',{accountCurrency:'USD'}),option('three',{accountCurrency:'UGX'})];
  const source=select(accounts()),destination=select(accounts());
  const channel=select(['Cash','Bank settlement','Mobile money','Internal transfer'].map(value=>option(value,{bankingChannel:value==='Internal transfer'?'transfer':'settlement'})));
  const field=element(),submit=element(),status=element();
  const entry=form('banking',{currency,kind,sourceId:source,destinationId:destination,paymentChannel:channel},{
    '[data-account-currency]':source.options[1],'[data-banking-destination-field]':field,'[data-banking-submit]':submit,'[data-banking-choices-status]':status
  },[source,destination]);
  run({operations:[entry]});
  assert.equal(destination.disabled,true);assert.equal(field.hidden,true);assert.equal(channel.value,'Cash');
  assert(channel.options.find(option=>option.value==='Internal transfer').disabled);
  source.value='one';source.emit('change');kind.value='transfer_request';kind.emit('change');
  assert.equal(destination.disabled,false);assert.equal(destination.required,true);assert.equal(field.hidden,false);
  assert.equal(channel.value,'Internal transfer');assert(channel.options.find(option=>option.value==='Cash').disabled);
  assert(destination.options.find(option=>option.value==='one').disabled);
  destination.value='two';source.value='two';source.emit('change');assert.equal(destination.value,'');
  currency.value='UGX';currency.emit('change');assert.equal(source.value,'');assert.equal(submit.disabled,true);
  assert.match(status.textContent,/two different accounts/);
  kind.value='withdrawal_request';kind.emit('change');assert.equal(submit.disabled,false);assert.equal(channel.value,'Cash');
  assert.equal(destination.disabled,true);assert.equal(destination.value,'');
  currency.value='SSP';currency.emit('change');assert.equal(submit.disabled,true);assert.match(status.textContent,/No customer account/);
});

test('banking dedicated forms render only channels supported by their operation',async()=>{
  const partial=path.resolve(__dirname,'../src/views/tenant/banking/_entry-form.ejs');
  for(const operation of ['deposit_request','withdrawal_request','transfer_request']){
    const html=await ejs.renderFile(partial,{currentBranch:{currency:'USD'},user:{name:'Teller'},data:{
      workspaceOperation:operation,workspaceTitle:operation,currencyChoices:[{code:'USD',label:'USD'}],references:[],idempotencyKey:'test'
    }});
    const channels=html.match(/<select class="control" name="paymentChannel">([\s\S]*?)<\/select>/)[1];
    if(operation==='transfer_request'){assert.match(channels,/Internal transfer/);assert.doesNotMatch(channels,/>Cash</);assert.match(html,/name="destinationId"/);}
    else{assert.match(channels,/>Cash</);assert.doesNotMatch(channels,/Internal transfer/);assert.doesNotMatch(html,/name="destinationId"/);}
  }
});

test('funding destinations exclude the same account and incompatible branches, currencies or assigned operators',()=>{
  const account=(value,branchId='main',currency='USD',operatorId='operator-one')=>option(value,{branchId,currency,operatorId});
  const accounts=()=>[option(''),account('source'),account('shared','main','USD',''),account('other-branch','east'),account('other-currency','main','UGX'),account('other-operator','main','USD','operator-two'),account('compatible')];
  const source=select(accounts()),destination=select(accounts(),'shared'),submit=element(),status=element();
  const entry=form('funding',{sourceAccountId:source,destinationAccountId:destination},{'[data-funding-submit]':submit,'[data-funding-choices-status]':status});
  run({funding:[entry]});
  assert.equal(destination.disabled,true);assert.equal(submit.disabled,true);
  source.value='source';source.emit('change');assert.equal(destination.value,'shared');assert.equal(submit.disabled,false);
  for(const value of ['source','other-branch','other-currency','other-operator'])assert(destination.options.find(option=>option.value===value).disabled,value);
  assert.equal(destination.options.find(option=>option.value==='compatible').disabled,false);
  destination.value='compatible';source.value='other-operator';source.emit('change');assert.equal(destination.value,'');assert.equal(submit.disabled,true);
  destination.value='shared';destination.emit('change');assert.equal(submit.disabled,false,'shared and assigned accounts can fund each other');
  source.value='other-branch';source.emit('change');assert.equal(destination.value,'');assert.equal(submit.disabled,true);assert.match(status.textContent,/No other eligible account/);
});

test('forex preview includes commission, offers supported currency pairs and adjusts validity to the selected rate',async()=>{
  const from=select(['USD','SSP'].map(value=>option(value)));
  const to=select(['UGX','USD','SSP'].map(value=>option(value)));
  const expires=minutes=>new Date(Date.now()+minutes*60000).toISOString();
  const rate=select([option(''),option('short',{from:'USD',to:'UGX',rate:'100',expiresAt:expires(8)}),option('long',{from:'USD',to:'SSP',rate:'10',expiresAt:expires(30)})],'short');
  const validity=select(Array.from({length:56},(_,index)=>option(String(index+5))),'15');
  const amount=element({value:'100'}),commission=element({value:'50'}),operation=element({value:'buy'}),total=element();
  const entry=form('forex',{rateId:rate,validMinutes:validity,amount,commission,operation},{'[data-forex-currency="from"]':from,'[data-forex-currency="to"]':to,'[data-forex-total]':total},[from,to]);
  run({operations:[entry]});
  assert.equal(validity.value,'7');assert.equal(validity.options.find(option=>option.value==='15').disabled,true);
  assert.equal(to.options.find(option=>option.value==='USD').disabled,true);
  assert.equal(total.textContent,'UGX 9,950 (indicative)');
  operation.value='sell';entry.emit('input');assert.equal(total.textContent,'UGX 10,050 (indicative)');
  operation.value='quote';entry.emit('input');assert.equal(total.textContent,'UGX 10,000 (indicative)');
  operation.value='buy';commission.value='10000';entry.emit('input');assert.equal(total.textContent,'—');assert.match(commission.validationMessage,/positive amount/);
  commission.value='0.5';entry.emit('input');assert.match(commission.validationMessage,/precision/);
  commission.value='50';to.value='SSP';entry.emit('input',{target:to});assert.equal(to.value,'SSP','native select input must not restore the previous rate before its change handler');to.emit('change');assert.equal(rate.value,'long');assert.equal(total.textContent,'SSP 950.00 (indicative)');assert.equal(commission.validationMessage,'');
  rate.options.find(option=>option.value==='long').dataset.expiresAt=expires(-1);rate.emit('change');
  assert.equal(rate.value,'');assert.match(rate.validationMessage,/enough remaining validity/);
  rate.value='short';rate.emit('change');assert.equal(rate.validationMessage,'','choosing a valid rate clears the previous expiry error');
  amount.value='200';entry.emit('reset');await Promise.resolve();assert.equal(total.textContent,'UGX 19,950 (indicative)','Clear recomputes the restored settlement values');
});


test('clearing a transfer restores currency-compatible destinations and its total',async()=>{
  const currency=select([option('USD'),option('UGX')],'USD'),destination=select([option(''),option('usd',{currencies:'USD'}),option('ugx',{currencies:'UGX'})]);
  const amount=element({value:'10'}),fee=element({value:'0'}),total=element();
  const entry=form('transfer',{currency,destinationBranchId:destination,amount,fee},{'[data-transfer-total]':total});
  run({operations:[entry]});assert(destination.options[2].disabled);assert.equal(total.textContent,'USD 10.00');
  currency.value='UGX';amount.value='20';entry.emit('reset');await Promise.resolve();
  assert(destination.options[1].disabled);assert.equal(destination.options[2].disabled,false);assert.equal(total.textContent,'UGX 20');
});
