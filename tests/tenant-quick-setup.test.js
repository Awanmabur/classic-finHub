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
 assert.equal(value.account.isDefault,'auto');
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
test('Money account naming and currency rules are explicit and cannot overwrite balance',()=>{
 const value=validation.moneyInput({
  kind:'cash',currency:'SSP',branchId:branch._id,name:'Front counter SSP cash',
  network:'',operatorId:'',accountReference:''
 },{},owner,[branch]);
 assert.equal(value.account.name,'Front counter SSP cash');
 assert.equal(value.account.isDefault,'auto');
 assert.equal(value.account.operatorId,owner.id);
 assert.throws(()=>validation.moneyInput({
  kind:'cash',currency:'SSP',branchId:branch._id,
  name:'Main cash',openingBalanceMinor:'5000'
 },{},owner,[branch]),{status:400});
 assert.throws(()=>validation.moneyInput({
  kind:'cash',currency:'SSP',branchId:branch._id,
  name:'Main cash',isDefault:true
 },{},owner,[branch]),{status:400});
 assert.equal(value.account.kind,'cash');
});
test('Quick setup has branch, staff and archived recovery but no duplicate money forms',async()=>{
 const base={users:0,invites:0,archivedAccounts:[],roles:['Mobile Money Operator'],
  branches:[],currencyCodes,timeZones:['Africa/Juba','Africa/Kampala']};
 const render=data=>ejs.renderFile(path.join(__dirname,'../src/views/tenant/setup/index.ejs'),
  {data,csrfToken:'test-csrf',assetVersion:'test',user:owner,tenant:{slug:'test-business'}});
 const fresh=await render(base);
 assert.match(fresh,/action="\/tenant\/setup\/branch"/);
 assert.doesNotMatch(fresh,/action="\/tenant\/setup\/staff"/);
 assert.doesNotMatch(fresh,/action="\/tenant\/setup\/account"/);
 const active=await render({...base,users:1,branches:[branch],
  archivedAccounts:[{_id:'fedcba987654321001234567',name:'Old draft',currency:'SSP',
   openingBalanceMinor:null,sequence:0}]});
 assert.match(active,/action="\/tenant\/setup\/staff"/);
 assert.match(active,/href="\/tenant\/treasury"/);
 assert.match(active,/\/tenant\/treasury\/accounts\/fedcba987654321001234567\/restore/);
 assert.doesNotMatch(active,/action="\/tenant\/setup\/account"/);
 assert.doesNotMatch(active,/setupStatsGrid/);
 assert.match(active,/Removed or closed accounts/);
 const freshBranch=await render({...base,branches:[]});
 for(const currency of currencyCodes)assert(freshBranch.includes('value="'+currency+'"'),'First branch currency setup supports '+currency);
 assert.match(active,/\/tenant\/treasury/);
 assert.doesNotMatch(active,/name="confirmed"/);
 assert.doesNotMatch(active,/name="evidenceReference"/);
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

test('Owner creates accounts on Money while branch manager keeps scoped advanced Treasury form',()=>{
 const page=file('src/views/tenant/treasury/index.ejs');
 const ownerMoney=file('src/views/tenant/treasury/_owner-accounts.ejs');
 const routes=file('src/tenant/treasury/routes.js');
 assert.match(page,/data\.canCreateAccount&&user\.role!=='Tenant Owner'/);
 assert.match(page,/include\('_owner-accounts'\)/);
 assert.match(ownerMoney,/action="\/tenant\/setup\/account"/);
 assert.match(ownerMoney,/data-money-create-kind/);
 assert.match(ownerMoney,/name="currency"/);
 assert.match(ownerMoney,/name="network"/);
 assert.match(routes,/router\.get\('\/accounts\/new'/);
 assert.match(routes,/\/tenant\/treasury#money-accounts/);
});
