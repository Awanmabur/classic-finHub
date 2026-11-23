'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {currencyCodes}=require('../src/config/currencies');
const {supported}=require('../src/tenant/services/branchCurrency.service');
const treasuryRouter=require('../src/tenant/treasury/routes');
const read=(file)=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('Treasury restores old capital routes without a second top-up form',()=>{
 const router=treasuryRouter({renderTenant:()=>{}});
 const routes=router.stack.filter(layer=>layer.route).map(layer=>({
  path:layer.route.path,methods:layer.route.methods
 }));
 for(const [url,method] of [
  ['/capital','get'],['/capital','post'],
  ['/accounts/:id/record','post'],['/accounts/:id','get']
 ])assert(routes.some(route=>route.path===url&&route.methods[method]),method+' '+url+' missing');
 const source=read('src/tenant/treasury/routes.js');
 assert(source.includes("treasury.addCapital(req.tenantDb,req.tenant,req.user"),'Old form must use the existing ledger service');
 assert(source.includes('result.duplicate'),'Repeated submission cannot be silently treated as new funds');
 const page=read('src/views/tenant/treasury/index.ejs');
 assert(!page.includes("include('_capital')"),'Do not restore a duplicate top-up form');
});

test('Treasury names all operating currencies while respecting branch restrictions',()=>{
 const ui=read('src/views/tenant/treasury/index.ejs');
 assert(ui.includes('data.currencyCodes.forEach(currency=>'),'Use centralized supported currency list');
 assert(ui.includes("data.setupBranch.currencies.includes(currency)"),'Mark disabled currencies for this branch');
 assert(ui.includes('/tenant/branches'),'Direct user to existing branch currency management');
 const available=supported({currency:'UGX',currencies:['UGX']});
 assert.deepEqual(available,['UGX']);
 assert.deepEqual([...currencyCodes],['UGX','USD','SSP','KES']);
});
