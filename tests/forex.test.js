'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const crypto=require('node:crypto');const ejs=require('ejs');const path=require('node:path');
const mongoose=require('mongoose');
const fx=require('../src/tenant/services/forex.service');
const {entitledTenant}=require('./helpers/entitlement');
const {hasModuleForUser,assignableModules}=require('../src/tenant/services/moduleAccess.service');
const {permissionsFor}=require('../src/config/roles');
const {tenantMenu}=require('../src/services/menu.service');
const {sourcesFor}=require('../src/tenant/services/operationsReports.service');
const base=entitledTenant({plan:'modular',enabledModules:[],moduleGrants:[
 {moduleKey:'forex',status:'granted',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01'),limits:{users:5,branches:1,recordsPerMonth:10}},
 {moduleKey:'reports',status:'granted',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01'),limits:{users:5,branches:1,recordsPerMonth:0}}
]});
const branch='507f1f77bcf86cd799439011';const actorId='507f1f77bcf86cd799439012';
function actor(role,modules=['forex']){return {id:actorId,role,branchId:branch,permissions:permissionsFor(role),allowedModules:modules};}
function fail(fn,status){assert.throws(fn,e=>e.status===status);}
test('Forex can be subscribed independently; reports remain independently subscribable',()=>{
 const op=actor('Forex Operator');assert(hasModuleForUser(base,op,'forex'));
 assert(!hasModuleForUser(base,op,'reports'));
 assert(tenantMenu(base,op).some(group=>group.items.some(item=>item.href==='/tenant/forex/buy')));
 assert(!tenantMenu(base,op).some(group=>group.items.some(item=>item.href==='/tenant/reports')));
 assert(assignableModules(base,'Forex Operator').includes('forex'));
 const analyst=actor('Reports Analyst',['forex','reports']);
 assert(sourcesFor(base,analyst).some(s=>s.key==='forex'));
 assert(!analyst.permissions.includes('forex.quotes.create'));
 assert(!sourcesFor({...base,moduleGrants:base.moduleGrants.filter(g=>g.moduleKey!=='forex')},analyst).some(s=>s.key==='forex'));
 assert(!sourcesFor({...base,moduleGrants:base.moduleGrants.filter(g=>g.moduleKey!=='reports')},analyst).length);
});
test('FX rates are exact fixed-point decimals and conversion does not use floating point',()=>{
 assert.equal(fx.rateScaled('0.00027500'),27500n);
 assert.equal(fx.rateScaled('1.23456789'),123456789n);
 assert.equal(fx.minor('20000','UGX'),20000n);
 assert.equal(fx.minor('123.45','USD'),12345n);
 assert.equal(fx.minor('0.50','USD'),50n);
 fail(()=>fx.minor('0.00','USD'),400);
 assert.equal(fx.converted(20000n,'UGX','USD',fx.rateScaled('0.000275')),550n);
 assert.equal(fx.converted(10001n,'KES','UGX',fx.rateScaled('29.40')),2940n);
 assert.equal(fx.amountLabel('550','USD'),'USD 5.50');
 assert.equal(fx.amountLabel('20000','UGX'),'UGX 20,000');
 for(const x of ['0','0.000000001','1e4','-1','1,234','1.234567891','Infinity'])fail(()=>fx.rateScaled(x),400);
 for(const x of ['10.00','0','-10','1e4','1000000000'])fail(()=>fx.minor(x,'UGX'),400);
 fail(()=>fx.converted(1n,'UGX','USD',1n),400);
});
test('Input validation requires valid pair, expiry, idempotency and explanations',()=>{
 const rate={fromCurrency:'UGX',toCurrency:'USD',rateDecimal:'0.000275',note:'Market reference documented by an operator',validHours:'24'};
 assert.equal(fx.rateInput(rate).toCurrency,'USD');
 fail(()=>fx.rateInput({...rate,toCurrency:'UGX'}),400);
 fail(()=>fx.rateInput({...rate,validHours:0}),400);
 fail(()=>fx.rateInput({...rate,note:'tiny'}),400);
 const quote={rateId:branch,customerLabel:'Client label',amount:'1000',note:'Customer requested an indicative quote',validMinutes:'10',idempotencyKey:crypto.randomUUID()};
 assert.equal(fx.quoteInput(quote).validMinutes,10);
 fail(()=>fx.quoteInput({...quote,validMinutes:61}),400);
 fail(()=>fx.quoteInput({...quote,idempotencyKey:'bad'}),400);
 fail(()=>fx.quoteInput({...quote,customerLabel:'x'}),400);
});
test('executable forex quotations use supported funds currencies and preserve a positive buy settlement',()=>{
 const input={operation:'buy',amount:'10.00',capture:{commission:'0'}};
 const rate={fromCurrency:'USD',toCurrency:'SSP',rateDecimal:'1'};
 assert.deepEqual(fx.quoteEconomics(input,rate),{sourceMinor:1000n,targetMinor:1000n});
 assert.deepEqual(fx.quoteEconomics({...input,capture:{commission:'9.99'}},rate),{sourceMinor:1000n,targetMinor:1000n});
 assert.throws(()=>fx.quoteEconomics({...input,capture:{commission:'10.00'}},rate),{status:400});
 assert.throws(()=>fx.quoteEconomics({...input,capture:{commission:'10.01'}},rate),{status:400});
 assert.deepEqual(fx.quoteEconomics({...input,operation:'sell',capture:{commission:'10.00'}},rate),{sourceMinor:1000n,targetMinor:1000n});
 for(const operation of ['buy','sell'])for(const pair of [{...rate,fromCurrency:'EUR'},{...rate,toCurrency:'EUR'}])assert.throws(()=>fx.quoteEconomics({...input,operation},pair),{status:409});
 assert.deepEqual(fx.quoteEconomics({...input,operation:'quote'},{...rate,fromCurrency:'EUR'}),{sourceMinor:1000n,targetMinor:1000n},'indicative EUR arithmetic and historical quotations remain supported');
});
test('posted forex history remains branch and originator scoped when filtering',async()=>{
 let query;const conn={models:{ForexQuoteV1:{find(value){query=value;return{sort(){return this;},limit(){return this;},lean:async()=>[]};}}}};
 await fx.listQuotes(conn,base,actor('Forex Operator'),{status:'posted_manual'});
 assert.deepEqual(query,{branchId:branch,createdBy:actorId,status:'posted_manual'});
 await assert.rejects(fx.listQuotes(null,base,actor('Forex Operator'),{status:'not_a_state'}),{status:400});
});
test('executable forex forms offer eligible approved pairs and a validity the selected rate can honor',async()=>{
 const rates=[{_id:'507f1f77bcf86cd799439021',branchId:branch,status:'active',fromCurrency:'EUR',toCurrency:'USD',rateDecimal:'1.10',expiresAt:new Date(Date.now()+3600000)},
  {_id:'507f1f77bcf86cd799439022',branchId:branch,status:'active',fromCurrency:'USD',toCurrency:'SSP',rateDecimal:'100',expiresAt:new Date(Date.now()+10*60000)},
  {_id:'507f1f77bcf86cd799439023',branchId:branch,status:'active',fromCurrency:'KES',toCurrency:'USD',rateDecimal:'0.01',expiresAt:new Date(Date.now()+3600000)}];
 const template=path.join(__dirname,'../src/views/tenant/forex/_entry-form.ejs');
 const locals={currentBranchId:branch,user:actor('Forex Operator'),data:{rates,workspaceOperation:'buy',currencyChoices:[{code:'USD'},{code:'SSP'}],idempotencyKey:crypto.randomUUID()}};
 const html=await ejs.renderFile(template,locals);
 assert.doesNotMatch(html,/value="(?:EUR|KES)"/);
 assert.doesNotMatch(html,new RegExp(rates[0]._id+'|'+rates[2]._id));
 assert.match(html,/data-expires-at="[^"]+"/);
 const validity=html.match(/<select name="validMinutes"[^>]*>([\s\S]*?)<\/select>/)[1];
 const selected=Number(validity.match(/<option value="(\d+)" selected/)[1]);
 assert(selected>=5&&selected<10);
 assert.match(validity,/<option value="15"\s+disabled/);
 const indicative=await ejs.renderFile(template,{...locals,data:{...locals.data,workspaceOperation:'quote'}});
 assert.match(indicative,/value="EUR"/);
 assert.match(indicative,/Indicative quotation/);
});
test('Tenant and branch access fail closed for unrelated roles and assignments',async()=>{
 const viewer=actor('Viewer'),op=actor('Forex Operator');
 await assert.rejects(fx.proposeRate(null,base,viewer,{}),{status:403});
 await assert.rejects(fx.decideRate(null,base,op,branch,{}),{status:403});
 await assert.rejects(fx.createQuote(null,base,actor('Forex Operator',[]),{}),{status:403});
 fail(()=>fx.branchFor(op,{branchId:'507f1f77bcf86cd799439015'}),403);
 assert.equal(fx.branchFor(op,{}),branch,'branch is resolved from the account');
 fail(()=>fx.branchScope({role:'Forex Operator',branchId:null}),403);
 assert.deepEqual(fx.branchScope(actor('Tenant Owner')),{});
 assert.deepEqual(fx.quoteScope(op),{branchId:branch,createdBy:actorId});
});
test('Forex schemas prevent mutable rate and quote snapshots and enforce unique keys',()=>{
 const rate=require('../src/tenant/schemas/ForexRate.schema');
 const quote=require('../src/tenant/schemas/ForexQuote.schema');
 for(const name of ['fromCurrency','toCurrency','rateDecimal','expiresAt'])assert(rate.path(name).options.immutable);
 for(const name of ['fromCurrency','toCurrency','rateDecimal','sourceMinor','targetMinor','rateId','expiresAt'])assert(quote.path(name).options.immutable);
 assert(rate.indexes().some(([fields,options])=>fields.branchId===1&&options.unique&&options.partialFilterExpression?.status==='active'));
 assert(quote.indexes().some(([fields,options])=>fields.idempotencyKey===1&&options.unique));
});
test('Standalone Forex reporting excludes customer details and uses branch-scoped aggregates',async()=>{
 let pipeline;const conn={models:{ForexQuoteV1:{aggregate:async p=>{pipeline=p;return [{_id:{from:'UGX',to:'USD',status:'quoted'},count:2,amount:{toString:()=> '20000'}}];}}}};
 const rows=await fx.reportRows({conn,filters:{},scope:{branchId:branch}});
 assert.equal(String(pipeline[0].$match.branchId),branch);
 assert.equal(rows[0].module,'Forex');assert.equal(rows[0].volume,'UGX 20,000');
 assert(!('customerLabel' in rows[0]));assert(!('rateDecimal' in rows[0]));
});
test('Forex UI uses existing card layout, CSRF protection, independent controls and escapes user values',async()=>{
 const html=await ejs.renderFile(path.join(__dirname,'../src/views/tenant/forex/index.ejs'),{
  user:{role:'Forex Operator'},csrfToken:'test-csrf',data:{canPropose:true,canQuote:true,canRateReview:false,canQuoteReview:false,
   selectedBranchId:branch,branches:[{_id:branch,name:'Test',currency:'UGX'}],rates:[],records:{items:[]},rateQueue:[],quoteQueue:[],idempotencyKey:crypto.randomUUID(),amountLabel:fx.amountLabel}
 });
 assert.match(html,/forex\/quotes/);assert.match(html,/forex\/rates/);assert.match(html,/name="_csrf" value="test-csrf"/);
 assert.doesNotMatch(html,/name="decision"/);assert.match(html,/record the actual exchange against opened foreign currency and settlement accounts for independent review/);
 const detail=await ejs.renderFile(path.join(__dirname,'../src/views/tenant/forex/detail.ejs'),{
  csrfToken:'x',data:{quote:{_id:branch,reference:'FX-test',status:'quoted',customerLabel:'<script>alert(1)<\/script>',
   fromCurrency:'UGX',toCurrency:'USD',sourceMinor:'20000',targetMinor:'550',rateDecimal:'0.000275',note:'Customer asked',expiresAt:new Date(),reviewNote:null},
   amountLabel:fx.amountLabel,canReview:false,canCancel:false}
 });
 assert.match(detail,/&lt;script&gt;/);assert.doesNotMatch(detail,/<script>/);
 assert.doesNotMatch(detail,/name="decision"/);
});
test('Expiry worker cannot enumerate tenants without an authorized cursor',async()=>{
 const run=require('../src/jobs/forexRateExpiry.job').run;
 await assert.rejects(run(),/cursor/);
 await assert.rejects(run({tenants:[],connectionForTenant:()=>({})}),/cursor/);
 await assert.rejects(fx.expireDue({},'not-a-date'),{status:400});
});
