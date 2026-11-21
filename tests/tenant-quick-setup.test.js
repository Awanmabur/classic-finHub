'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');
const setup=require('../src/tenant/setup/routes');
const branchService=require('../src/tenant/services/branch.service');
const treasury=require('../src/tenant/treasury/service');
const staffPolicy=require('../src/tenant/services/staffPolicy');
const {currencyCodes}=require('../src/config/currencies');
const file=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const branch={_id:'0123456789abcdef01234567',name:'Main branch',status:'active',
  currency:'SSP',currencies:['SSP'],timeZone:'Africa/Juba'};
const owner={role:'Tenant Owner',id:'1234567890abcdef12345678',permissions:['*']};
const validation=setup.validation;
test('Quick setup branch only needs business name, region timezone and currency; backend generates branch code',()=>{
 const values=validation.branchInput({name:'Main branch',currency:'SSP',timeZone:'Africa/Juba',_csrf:'test'});
 assert.deepEqual(values,{name:'Main branch',currency:'SSP',timeZone:'Africa/Juba'});
 assert(!('code' in values));
 assert.throws(()=>validation.branchInput({name:'Main',currency:'SSP',timeZone:'fake/region'}),{status:400});
 assert.throws(()=>validation.branchInput({name:'Main',currency:'SSP',timeZone:'Africa/Juba',status:'active'}),{status:400});
 const service=branchService.create.toString();
 assert.match(service,/validate\(input,true\)/);
});
test('Staff invitations derive role-limited subscribed modules without permitting custom privilege escalation',()=>{
 const roles=staffPolicy.managedRoles(owner);
 assert(roles.length>0);
 const values=validation.inviteInput({name:'Staff',email:'person@example.com',
   role:roles[0],branchId:branch._id,_csrf:'test'}, {},roles,[branch]);
 assert.equal(values.branchId,branch._id);
 assert(Array.isArray(values.allowedModules));
 assert.throws(()=>validation.inviteInput({name:'Staff',email:'person@example.com',
   role:'Tenant Owner',branchId:branch._id}, {},roles,[branch]),{status:403});
 assert.throws(()=>validation.inviteInput({name:'Staff',email:'person@example.com',
   role:roles[0],branchId:'ffffffffffffffffffffffff'}, {},roles,[branch]),{status:400});
 assert.throws(()=>validation.inviteInput({name:'Staff',email:'person@example.com',
   role:roles[0],branchId:branch._id,allowedModules:['banking']}, {},roles,[branch]),{status:400});
});
test('Cash account setup generates name, chooses real operator and never creates opening money',()=>{
 const value=validation.moneyInput({kind:'cash',currency:'SSP',branchId:branch._id,
   network:'',operatorId:'',accountReference:'',_csrf:'test'}, {},owner,[branch]);
 assert.equal(value.branchId,branch._id);
 assert.equal(value.account.kind,'cash');
 assert.equal(value.account.operatorId,owner.id);
 assert.equal(value.account.isDefault,true);
 assert(!Object.hasOwn(value.account,'openingBalanceMinor'));
 assert(!Object.hasOwn(value.account,'bookBalanceMinor'));
 assert(!Object.hasOwn(value.account,'amount'));
 assert(!Object.hasOwn(value.account,'status'));
 assert.equal(value.account.name,'Cash drawer SSP');
 assert.throws(()=>validation.moneyInput({kind:'cash',currency:'UGX',
   branchId:branch._id,network:''}, {},owner,[branch]),{status:400});
 assert.throws(()=>validation.moneyInput({kind:'cash',currency:'SSP',
   branchId:branch._id,network:'',amount:'100000'}, {},owner,[branch]),{status:400});
});
test('Quick setup templates expose only real existing forms and accurate financial readiness',async()=>{
 const base={users:0,invites:0,accounts:[],readyCount:0,roles:['Mobile Money Operator'],
  branches:[],staff:[],kinds:['cash','bank'],kindLabel:{cash:'Cash drawer',bank:'Bank account'},
  networks:[],networkCurrencies:{},currencyCodes,timeZones:['Africa/Juba','Africa/Kampala']};
 const render=data=>ejs.renderFile(path.join(__dirname,'../src/views/tenant/setup/index.ejs'),
  {data,csrfToken:'test-csrf',user:owner,tenant:{slug:'test-business'}});
 const fresh=await render(base);
 assert.match(fresh,/action="\/tenant\/setup\/branch"/);
 assert(!fresh.includes('action="/tenant/setup/staff"'));
 assert(!fresh.includes('action="/tenant/setup/account"'));
 const active=await render({...base,branches:[branch],
   staff:[{_id:'fedcba987654321001234567',name:'Cashier',role:'Mobile Money Operator'}],
   accounts:[{_id:'fedcba987654321001234567',name:'Main cash',kind:'cash',
     currency:'SSP',status:'uninitialized',reconciliationState:'unknown',
     openingBalanceMinor:null,openingApprovedAt:null}]});
 for(const action of ['/tenant/setup/staff','/tenant/setup/account'])
   assert(active.includes('action="'+action+'"'));
 assert(active.includes('Cashier'));
 assert(active.includes('Record actual opening'));
 assert(active.includes('not confirmed'));
 assert(!active.includes('Approve staff'));
 assert(!active.includes('Create 1000000 SSP'));
});
test('Quick setup routes are authenticated, owner-scoped, CSRF protected and reuse existing transaction services',()=>{
 const routes=file('src/tenant/setup/routes.js'),entry=file('src/tenant/routes/index.js');
 assert(entry.includes("router.use('/setup',require('../setup/routes')"));
 for(const permission of ['dashboard.view','branches.manage','users.manage_branch','treasury.manage'])
  assert(routes.includes("requirePermission('"+permission+"')"));
 assert(routes.includes('owner(req)'));
 assert(routes.includes('branchService.create(req.tenant,req.user,form)'));
 assert(routes.includes('staffService.issueInvite(req.tenant,req.user,values)'));
 assert(routes.includes('treasury.createAccount(req.tenantDb,req.tenant,req.user'));
 assert(routes.includes('configurationBranchId:values.branchId'));
 assert(file('src/views/tenant/setup/index.ejs').includes('name="_csrf"'));
 assert(file('src/services/menu.service.js').includes("item('Quick setup','setup'"));
});
