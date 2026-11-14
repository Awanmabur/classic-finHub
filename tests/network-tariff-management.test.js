'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const ejs=require('ejs');
const service=require('../src/tenant/pricing/networkTariffService');
const root=path.resolve(__dirname,'..');

const base={
 network:'MTN SSD',operation:'cash_in',scheduleKind:'agent_commission',currency:'SSP',branchId:'507f1f77bcf86cd799439011',
 effectiveFrom:'2026-11-14',expiresAt:'',
 evidenceReference:'Verified rate-sheet copy, issued by provider 2026',
 bands:'100, 1000, basis_points, 250\n1001, 5000, flat, 120'
};
test('editing agent commission bands uses strict decimal-free minor units',()=>{
 assert.equal(service.parseLines(base.bands).length,2);
 assert.equal(service.serializeLines(service.parseLines(base.bands)).split('\n').length,2);
 assert.equal(service.validateInput(base).network,'MTN SSD');
 assert.equal(service.validateInput(base).currency,'SSP');
});
test('no cross-market, duplicate band, missing source, or arbitrary operation tariff can be stored',()=>{
 const mutate=[
 {...base,network:'MTN'}, {...base,currency:'UGX'},
 {...base,operation:'transfer'}, {...base,scheduleKind:'unknown'}, {...base,branchId:''},
 {...base,evidenceReference:'short'}, {...base,effectiveFrom:'2026-02-30'},
 {...base,expiresAt:'2026-11-13'}, {...base,bands:'1, 100, flat, 50\n50, 1000, flat, 100'},
 {...base,bands:'1, 100, basis_points, 10001'}, {...base,bands:'1, 100, flat, -5'},
 {...base,actorId:'507f1f77bcf86cd799439011'}
 ];
 for(const bad of mutate)assert.throws(()=>service.validateInput(bad),JSON.stringify(bad));
});
test('agent tariff UI escapes provider reference and offers protected independent approval',async()=>{
 const row={
  _id:'507f1f77bcf86cd799439011',
  branchId:'507f1f77bcf86cd799439012',network:'MTN SSD',currency:'SSP',operation:'cash_in',scheduleKind:'agent_commission',
  version:1,status:'draft',revision:0,
  effectiveFrom:new Date('2026-11-14T00:00:00Z'),approvedBy:null,
  evidenceReference:'<script>alert(1)</script> provider source',
  tiers:service.parseLines(base.bands)
 };
 const html=await ejs.renderFile(path.join(root,'src/views/tenant/mobile-money/tariffs.ejs'),{
  assetVersion:'test',csrfToken:'csrf-test',
  data:{
   schedules:[row],branches:[{_id:'507f1f77bcf86cd799439012',name:'Juba Branch',status:'active'}],
   providerChoices:[{key:'MTN SSD',displayName:'MTN MoMo South Sudan',currency:'SSP'}],
   canPropose:true,canReview:true,canSubmitPayout:false,canReviewPayout:false,postingEnabled:false,
   customerTariffReferences:require('../src/tenant/pricing/customerNetworkFees').TABLES,
   commissions:{records:[],wallets:[]},serializeLines:service.serializeLines,
   formatMinor:require('../src/tenant/services/mobileMoney.service').formatMoneyMinor
  }
 });
 assert(html.includes('MTN MoMo South Sudan'));
 assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
 assert(!html.includes('<script>alert(1)</script>'));
 assert.match(html,/name="_csrf" value="csrf-test"/);
 assert.match(html,/name="bands"/);
 assert.match(html,/name="revision" value="0"/);
 assert.match(html,/action="\/tenant\/mobile-money\/tariffs\/507f1f77bcf86cd799439011\/approve"/);
 assert.doesNotMatch(html,/walletBalanceMinor|bookBalanceMinor|netProfitMinor/);
});
test('tariff-only endpoints do not invoke ledger movements or legacy fee posting',()=>{
 const routes=fs.readFileSync(path.join(root,'src/tenant/routes/mobileMoneyTariffs.routes.js'),'utf8');
 const serviceFile=fs.readFileSync(path.join(root,'src/tenant/pricing/networkTariffService.js'),'utf8');
 assert.doesNotMatch(routes+serviceFile,/applyMovements\(|recordMobileMoney\(|ensureCounterAccount\(/);
 assert.match(routes,/requireModule\('mobile_money'\)/);
 assert.match(routes,/requirePermission\('mobile_money.view'\)/);
 assert.match(serviceFile,/treasury\.access\(conn,tenant,actor,\{permission:'treasury.observe',sourceType:'mobile_money',session,fence:true\}\)/);
 assert.match(serviceFile,/Only the original agent may edit their branch draft/);
 assert.match(serviceFile,/String\(prior.createdBy\)===auth.actor.id/);
});

test('customer charges are distinctly labeled and never become agent commission estimates',async()=>{
 const schedule={
  network:'MTN',operation:'send',scheduleKind:'customer_network_fee',currency:'UGX',
  version:1,status:'approved',
  tiers:[{minMinor:'1',maxMinor:'5000',rate:{kind:'flat',value:'100'}}]
 };
 const q=service.preview(schedule,'3000');
 assert.equal(q.customerNetworkChargeEstimateMinor,'100');
 assert.equal(q.grossCommissionEstimateMinor,undefined);
 assert.equal(q.postsToLedger,false);
 const html=await ejs.renderFile(path.join(root,'src/views/tenant/mobile-money/tariff-quote.ejs'),{
  data:{schedule,result:q,formatMinor:(minor,currency)=>currency+' '+minor}
 });
 assert.match(html,/Customer network charge estimate/);
 assert.match(html,/Not agent income/);
 assert.match(html,/No physical cash, network float/);
});

test('Mongo tariff partial indexes have distinct stable names and maintain unique status scopes',()=>{
 const schema=require('../src/tenant/pricing/networkTariffModels').schema;
 const indexes=schema.indexes();
 const partial=indexes.filter(([,opts])=>opts.partialFilterExpression?.status);
 assert.equal(partial.length,2);
 assert.deepEqual(new Set(partial.map(([,opts])=>opts.name)),new Set([
  'agent_tariff_unique_approved_v1','agent_tariff_unique_draft_v1'
 ]));
 assert.deepEqual(new Set(partial.map(([,opts])=>opts.partialFilterExpression.status)),new Set(['approved','draft']));
 for(const [keys,opts] of partial){
  assert.equal(opts.unique,true);
  assert.deepEqual(Object.keys(keys),['tenantId','branchId','network','currency','operation','scheduleKind']);
 }
 assert.equal(new Set(indexes.map(([,opts])=>opts.name).filter(Boolean)).size,indexes.filter(([,opts])=>opts.name).length);
});

test('draft evidence edit accepts normal document references but rejects control characters',()=>{
 const source=fs.readFileSync(path.join(root,'src/tenant/pricing/networkTariffService.js'),'utf8');
 const edit=source.slice(source.indexOf('async function revise('),source.indexOf('async function decide('));
 assert(edit.includes('/[\\u0000-\\u001f\\u007f]/.test(evidenceReference)'));
 assert(!edit.includes('/[\\\\u0000-\\\\u001f\\\\u007f]/.test(evidenceReference)'));
 const pattern=/[\u0000-\u001f\u007f]/;
 assert.equal(pattern.test('MTN Uganda official November 2026 agent agreement'),false);
 assert.equal(pattern.test('MTN Uganda\u0000agreement'),true);
});

test('market-specific commission sheets use known currency or approved branch wallet',()=>{
 const fixed=service.validateInput({...base,network:'MTN',currency:undefined});
 assert.equal(fixed.currency,'UGX');
 const custom=service.validateInput({...base,network:'Africell',currency:'SSP',walletAccountId:'507f1f77bcf86cd799439099'});
 assert.equal(custom.currency,'SSP');
 assert.equal(String(custom.walletAccountId),'507f1f77bcf86cd799439099');
 assert.throws(()=>service.validateInput({...base,network:'Africell',currency:'SSP'}));
 assert.throws(()=>service.validateInput({...base,network:'MTN',currency:'SSP'}));
 const src=fs.readFileSync(path.join(root,'src/tenant/pricing/networkTariffService.js'),'utf8');
 assert.match(src,/reconciliationState:'matched'/);
 assert.match(src,/kind:'wallet'/);
 assert.match(src,/branchId:details\.branchId/);
});

test('provider directory shows all five registered network slots and an editable rate grid script',async()=>{
 const template=fs.readFileSync(path.join(root,'src/views/tenant/mobile-money/tariffs.ejs'),'utf8');
 const script=fs.readFileSync(path.join(root,'public/js/network-tariffs.js'),'utf8');
 assert.match(template,/data\.allProviders/);
 assert.match(template,/data-choose-operation/);
 assert.match(template,/data-provider-currency/);
 assert.match(template,/data-tariff-market-wallet/);
 assert.match(template,/networkTariffScroll/);
 assert.match(script,/Add amount range/);
 assert.match(script,/Remove this amount range/);
 assert.match(script,/data-payout-wallet/);
});
