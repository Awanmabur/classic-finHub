'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');
const {templates}=require('../src/tenant/pricing/publishedRateActivation');
const {group}=require('../src/tenant/pricing/networkRateSheetPresentation');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const branchId='507f1f77bcf86cd799439012';
const records=()=>templates('MTN','all').map((t,i)=>({...t,_id:'507f1f77bcf86cd7994390'+String(i+11),
 branchId,status:'approved',version:1,sourceKind:'published_reference',effectiveFrom:new Date('2026-11-16T00:00:00Z'),
 approvedBy:'507f1f77bcf86cd799439020',createdBy:'507f1f77bcf86cd799439021'}));
const rate=(op,amountMinor)=>{
 const sheet=group(records(),[{_id:branchId,name:'Central branch'}])[0],table=sheet.operations.find(o=>o.key===op);
 return table.rows.find(r=>BigInt(r.minMinor)<=BigInt(amountMinor)&&BigInt(amountMinor)<=BigInt(r.maxMinor));
};
test('four authorized MTN rate components appear as ONE provider sheet with deposit and withdrawal',()=>{
 const sheets=group(records(),[{_id:branchId,name:'Central branch'}]);
 assert.equal(sheets.length,1);
 assert.equal(sheets[0].completeMTN,true);
 assert.deepEqual(sheets[0].operations.map(o=>o.key),['cash_in','cash_out']);
 assert.equal(rate('cash_out',100000).commission.value,'600');
 assert.equal(rate('cash_out',100000).charge.value,'1925');
 assert.equal(rate('cash_out',4000000).commission.value,'4500');
 assert.equal(rate('cash_out',4000000).charge.value,'18000');
 assert.equal(rate('cash_in',500000).commission.value,'950');
 assert.equal(rate('cash_in',500000).charge.value,'0');
 assert.equal(group([...records(),{...records()[0],branchId:'507f1f77bcf86cd799439099'}]).length,2,
  'Separate branches preserve their own financial rate scopes');
});
test('no missing provider panels and approved MTN sheet never shows duplicate authorization action',async()=>{
 const rateSheets=group(records(),[{_id:branchId,name:'Central branch'}]);
 const html=await ejs.renderFile(path.join(root,'src/views/tenant/mobile-money/tariffs.ejs'),{
  assetVersion:'test',csrfToken:'csrf-test',user:{id:'owner',branchId,role:'Tenant Owner'},
  data:{
   schedules:records(),providerSheets:rateSheets,selectedBranchId:branchId,
   branches:[{_id:branchId,name:'Central branch'}],providerChoices:[],allProviders:[{key:'MTN',currency:'UGX'}],
   canPropose:false,canReview:false,canActivatePublished:true,canSubmitPayout:false,postingEnabled:false,
   commissions:{records:[],wallets:[{network:'MTN',currency:'UGX',branchId}]},
   formatMinor:(n,c)=>c+' '+Number(n).toLocaleString('en-US'),
   customerTariffReferences:[],serializeLines:()=>''
  }
 });
 assert.equal((html.match(/class="networkTariffRecord"/g)||[]).length,1,'one provider card');
 assert.match(html,/Deposit rates/);
 assert.match(html,/Withdrawal rates/);
 assert.match(html,/UGX 4,500/);
 assert.match(html,/UGX 18,000/);
 assert.doesNotMatch(html,/Authorize existing MTN rates/);
 assert.doesNotMatch(html,/Received provider commissions/);
 assert.doesNotMatch(html,/No provider network has/);
 assert.doesNotMatch(html,/Custom provider rates/);
});
test('owner can authorize entire MTN sheet once without entering customer fees or commission bands',async()=>{
 const html=await ejs.renderFile(path.join(root,'src/views/tenant/mobile-money/tariffs.ejs'),{
  assetVersion:'test',csrfToken:'csrf-test',user:{id:'owner',branchId,role:'Tenant Owner'},
  data:{
   schedules:[],providerSheets:[],selectedBranchId:branchId,
   branches:[{_id:branchId,name:'Central branch'}],providerChoices:[],allProviders:[],
   canPropose:false,canReview:false,canActivatePublished:true,canSubmitPayout:false,postingEnabled:false,
   commissions:{records:[],wallets:[{network:'MTN',currency:'UGX',branchId}]},
   formatMinor:(n,c)=>c+' '+String(n),customerTariffReferences:[],serializeLines:()=>''
  }
 });
 assert.equal((html.match(/Authorize existing MTN rates/g)||[]).length,1);
 assert.match(html,/name="scheduleKind" value="all"/);
 assert.doesNotMatch(html,/name="bands"/);
});
test('unconfigured service fee, unloaded quotes and empty review panels stay hidden without removing secure form fields',()=>{
 const entry=read('src/views/tenant/mobile-money/_entry-form.ejs');
 const pricing=read('src/views/tenant/partials/operation-pricing.ejs');
 const js=read('public/js/operation-pricing.js');
 const quote=read('public/js/mobile-money-quote.js');
 const index=read('src/views/tenant/mobile-money/index.ejs');
 assert.match(entry,/data-mobile-provider-quote aria-live="polite" hidden/);
 assert.match(pricing,/isMobilePricing&&!initialMobileRate/);
 assert.match(pricing,/name="pricingPolicy"/);
 assert.match(js,/host\.hidden=fee===0n&&cost===0n/);
 assert.match(quote,/if\(!hasCommission&&!hasCharge\)\{hide\(\);return;\}/);
 assert.match(index,/needsOnboarding=!currentBranch\|\|!hasUsableFundsPair/);
 assert.match(index,/data\.canReview&&\(data\.voidQueue\|\|\[\]\)\.length/);
 assert.doesNotMatch(index,/No matching agent commission sheet/);
});
