'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const path=require('node:path');
const branch={_id:'507f1f77bcf86cd799439011',name:'Nairobi Main',currency:'KES',currencies:['KES'],status:'active'};
const data={currencyChoices:require('../src/tenant/services/branchCurrency.service').options(branch),branches:[branch],selectedBranchId:String(branch._id),canRecord:true,canOpen:true,canCreate:true,
 canManage:true,canPropose:true,canQuote:true,canSubmit:true,canReview:false,canRateReview:false,
 canQuoteReview:false,canDecide:()=>false,summary:{total:0,recent:[],summaries:[]},records:{items:[]},
 shifts:{items:[]},contacts:[],references:[],institutions:[],policies:[],reviewQueue:[],voidQueue:[],
 rateQueue:[],quoteQueue:[],rates:[],queue:[],countryOptions:[],roles:[],categories:[],idempotencyKey:'test'};
const user={id:'507f1f77bcf86cd799439012',name:'Owner',role:'Tenant Owner',permissions:['*'],branchId:String(branch._id)};
const files=['mobile-money/index','mobile-money/shifts','money-transfer/index','money-transfer/contacts',
 'banking/index','banking/accounts','forex/index','approvals/index'];
const render=(file,options={})=>ejs.renderFile(path.resolve(__dirname,'../src/views/tenant',file+'.ejs'),{
 data,user,csrfToken:'test',operationBranch:branch,operationBranchError:'',money:()=>'',amountFromMinor:()=>'',...options});

test('operational forms show the account branch and never submit a branch selector or hidden override',async()=>{
 for(const file of files){
  const html=await render(file);
  assert.doesNotMatch(html,/<(?:select|input)\b[^>]*name="branchId"/,file);
  assert.match(html,/Operating at <strong>Nairobi Main<\/strong> · KSH/,file);
  if(file==='mobile-money/index'){
   const currency=html.match(/<select\b[^>]*name="currency"[^>]*>([\s\S]*?)<\/select>/);
   assert(currency,'Approved currency control must be present');
   assert.deepEqual([...currency[1].matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(match=>match[1]),['KES']);
   assert.match(currency[1],/>KSH<\/option>/);
  }
  if(['money-transfer/index','banking/index','banking/accounts'].includes(file)){
   const currency=html.match(/<select\b[^>]*name="currency"[^>]*>([\s\S]*?)<\/select>/);assert(currency,file);
   assert.deepEqual([...currency[1].matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(match=>match[1]),['KES']);
   assert.doesNotMatch(html,/<input type="hidden" name="currency"/,file);
  }
 }
});

test('ambiguous owner branch context cannot be replaced by a selected branch from page data',async()=>{
 const multiple=[branch,{...branch,_id:'507f1f77bcf86cd799439099',name:'Other Branch'}];
 const actions=['/tenant/mobile-money/cash-in','/tenant/mobile-money/shifts/open','/tenant/money-transfer/requests',
  '/tenant/money-transfer/contacts','/tenant/banking/requests','/tenant/banking/accounts','/tenant/forex/rates',
  '/tenant/forex/quotes','/tenant/approvals/requests'];
 for(const file of files){
  const html=await render(file,{user:{...user,branchId:null},data:{...data,branches:multiple},operationBranch:null,
   operationBranchError:'An operating branch must be assigned.'});
  assert.match(html,/data-operation-branch-error/,file);
  assert.match(html,/An operating branch must be assigned\./,file);
  assert.match(html,/href="\/tenant\/branches"/,file);
  for(const action of actions){
   const escaped=action.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   assert.doesNotMatch(html,new RegExp('<form\\b[^>]*action="'+escaped+'"'),file+' '+action);
  }
 }
});

test('a branch default does not hide its other enabled transaction currencies',async()=>{
 const all={...branch,currencies:['UGX','USD','SSP','KES']};
 const choices=require('../src/tenant/services/branchCurrency.service').options(all);
 for(const file of ['money-transfer/index','banking/index','banking/accounts']){
  const html=await render(file,{operationBranch:all,data:{...data,branches:[all],currencyChoices:choices,selectedCurrency:'USD'}});
  const currency=html.match(/<select\b[^>]*name="currency"[^>]*>([\s\S]*?)<\/select>/);assert(currency,file);
  assert.deepEqual([...currency[1].matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(match=>match[1]),['UGX','USD','SSP','KES']);
  assert.match(currency[1],/value="USD" selected/);
  assert.match(html,/Operating at <strong>Nairobi Main<\/strong> · USD/);
 }
});
