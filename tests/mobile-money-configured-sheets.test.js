'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),ejs=require('ejs');
const service=require('../src/tenant/pricing/networkTariffService');
const template=path.join(__dirname,'../src/views/tenant/mobile-money/tariffs.ejs');
test('built-in MTN commission and customer charge sheets are usable without inventing new bands',()=>{
 const deposit=service.builtInReference('MTN','agent_commission','cash_in');
 const withdrawal=service.builtInReference('MTN','agent_commission','cash_out');
 const charged=service.builtInReference('MTN','customer_network_fee','cash_out');
 const free=service.builtInReference('MTN','customer_network_fee','cash_in');
 assert(deposit.tiers.length>=10&&withdrawal.tiers.length>=10);
 assert.equal(deposit.tiers.find(t=>t.minMinor==='125001').rate.value,'500');
 assert.equal(withdrawal.tiers.find(t=>t.minMinor==='125001').rate.value,'1000');
 assert.equal(charged.tiers.find(t=>t.minMinor==='125001').rate.value,'3575');
 assert.equal(free.tiers[0].rate.value,'0');
 assert.equal(free.currency,'UGX');
 assert.equal(service.builtInReference('Airtel','agent_commission','cash_in'),null);
 assert.equal(service.builtInReference('Airtel','customer_network_fee','cash_out'),null,
  'Historical Airtel reference cannot be activated as verified rates without current evidence');
});
test('MTN-only tenant rate page shows no unconfigured Airtel/USD and reuses existing tables',async()=>{
 const html=await ejs.renderFile(template,{
  assetVersion:'test',csrfToken:'csrf-123',
  data:{
   networkMarkets:[{network:'MTN',currency:'UGX',label:'MTN MoMo Uganda'}],
   selectedBranchId:'507f1f77bcf86cd799439011',
   funds:{paymentAccounts:[{id:'cash1',kind:'cash',currency:'UGX',name:'Real cash',expected:'UGX 100',reconciliation:'matched'},
    {id:'cash2',kind:'cash',currency:'USD',name:'Unrelated bank cash',expected:'USD 2',reconciliation:'matched'}],
    wallets:[{id:'wallet1',kind:'wallet',network:'MTN',currency:'UGX',name:'Real float',expected:'UGX 200',
     reconciliation:'matched',state:'active',cashDrawerAccountId:'cash1'}]},
   schedules:[],commissions:{records:[],wallets:[]},
   allProviders:[{key:'MTN',displayName:'MTN MoMo Uganda',currency:'UGX',configured:true}],
   providerChoices:[{key:'MTN',displayName:'MTN MoMo Uganda',currency:'UGX'}],
   customerTariffReferences:require('../src/tenant/pricing/customerNetworkFees').TABLES.filter(x=>x.network==='MTN'),
   agentReferenceRates:{deposit:require('../src/tenant/pricing/networkTariffs').publicAgentReference('cash_in'),
    withdrawal:require('../src/tenant/pricing/networkTariffs').publicAgentReference('cash_out')},
   branches:[{_id:'507f1f77bcf86cd799439011',name:'Sherikat',status:'active'}],
   canPropose:true,canReview:true,canSubmitPayout:false,canReviewPayout:false,postingEnabled:false,
   actorRole:'Mobile Money Operator',actorId:'507f1f77bcf86cd799439012',
   serializeLines:service.serializeLines,
   formatMinor:(minor,currency)=>currency+' '+minor
  }
 });
 assert.match(html,/Use existing MTN rate sheets/);
 assert.match(html,/Existing provider rate tables/);
 assert.match(html,/customer network charges/);
 assert.match(html,/MTN MoMo Uganda/);
 assert.doesNotMatch(html,/Airtel|Africell|M-Pesa|USD|Unrelated bank cash|fabricated teaching/);
 assert.match(html,/action="\/tenant\/mobile-money\/tariffs\/existing-reference"/);
});
test('Mobile Money cards use the approved dashboard stat radius without overriding pills',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../public/css/workspace.css'),'utf8');
 assert.match(css,/networkBalanceStat.*networkProviderCard/s);
 assert.match(css,/border-radius:24px!important/);
 assert.match(css,/border-radius:var\(--pill,999px\)!important/);
 const router=fs.readFileSync(path.join(__dirname,'../src/tenant/routes/mobileMoneyTariffs.routes.js'),'utf8');
 assert.match(router,/market\.markets\(funds\?\.wallets\|\|\[\]\)/);
 assert.match(router,/customerTariffReferences:.*\.filter\(ref=>activeNetworks\.has\(ref\.network\)\)/);
 assert.match(router,/service\.importExistingReferences/);
});
