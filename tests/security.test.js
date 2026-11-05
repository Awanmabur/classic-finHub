'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePassword } = require('../src/platform/services/authentication.service');
const { hasModule, hasPermission, canUse } = require('../src/tenant/services/moduleAccess.service');
const { tenantMenu } = require('../src/services/menu.service');
const { tenantDbNameFromSlug } = require('../src/config/mongo');
const { checkPayload } = require('../src/platform/services/tenantProvisioning.service');
const mm = require('../src/tenant/services/mobileMoney.service');
const { checkStaff } = require('../src/tenant/services/staff.service');
const { permissionsFor } = require('../src/config/roles');
const {entitledTenant}=require('./helpers/entitlement');
const tenant=entitledTenant({slug:'company-a',moduleGrants:[{moduleKey:'reports',status:'granted',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01'),limits:{users:3,branches:1,recordsPerMonth:0}}]});
const owner = { name:'Owner',role:'Tenant Owner',permissions:['*'] };
const operator = { name:'Teller',role:'Mobile Money Operator',permissions:['dashboard.view','mobile_money.view','mobile_money.cash_in','mobile_money.cash_out'],allowedModules:['mobile_money'] };
const auditor = { name:'Auditor',role:'Auditor',permissions:['dashboard.view','mobile_money.view','reports.view','reports.export'],allowedModules:['mobile_money','reports'] };
test('tenant database names reject malicious identifiers', () => {
  assert.equal(tenantDbNameFromSlug('client-10'),'classicfin_tenant_client_10_db');
  for(const bad of ['../admin','a','Admin','admin.db','evil/$where','', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) assert.throws(()=>tenantDbNameFromSlug(bad));
});
test('module access requires tenant AND plan entitlements, never defaults to allow',()=>{
  assert.equal(hasModule(tenant,'mobile_money'),true);
  assert.equal(hasModule({ ...tenant, plan:'finance' },'mobile_money'),false);
  assert.equal(hasModule({ ...tenant, enabledModules:[] },'mobile_money'),false);
  assert.equal(hasModule(null,'mobile_money'),false);
  assert.equal(canUse(tenant,operator,'mobile_money','mobile_money.cash_in'),true);
  assert.equal(canUse(tenant,auditor,'mobile_money','mobile_money.cash_out'),false);
  assert.equal(hasPermission({ },'reports.view'),false);
  assert.equal(hasPermission({permissions:[]},'reports.view'),false);
});
test('dashboard navigation differs by role and tenant plans', () => {
  const paths = user => tenantMenu(tenant,user).flatMap(g=>g.items.map(i=>i.href));
  assert(paths(operator).includes('/tenant/mobile-money'));
  assert(!paths(operator).includes('/tenant/reports'));
  assert(!paths(operator).includes('/tenant/billing'));
  assert(paths(auditor).includes('/tenant/reports'));
  assert(!paths(auditor).includes('/tenant/billing'));
  assert(paths(owner).includes('/tenant/billing'));
  assert(!paths(owner).includes('/tenant/forex'));
  assert(!tenantMenu({...tenant, plan:'finance'},owner).flatMap(g=>g.items.map(i=>i.href)).includes('/tenant/mobile-money'));
});
test('tenant provisioning validates plan + slug and refuses unsupported module injection',()=>{
  const p=checkPayload({name:'Company One',slug:'company-one',owner:'Owner',email:'owner@example.com',plan:'agent',enabledModules:['banking','forex','mobile_money']});
  assert(!p.enabledModules.includes('banking'));
  assert(p.enabledModules.includes('mobile_money'));
  assert.throws(()=>checkPayload({name:'Bad',slug:'../other',owner:'Owner',email:'owner@example.com',plan:'enterprise'}));
  assert.throws(()=>checkPayload({name:'Company One',slug:'company-one',owner:'Owner',email:'owner@example.com',plan:'nonexistent'}));
});
test('strong passwords are enforced during account activation',()=>{
  assert.equal(validatePassword('Short123!'),false);
  assert.equal(validatePassword('longbutonlylowercase'),false);
  assert.equal(validatePassword('A-Very-Strong-Passphrase-123'),true);
});
test('password creation rejects bcrypt-truncated ASCII and multibyte suffixes',()=>{
  assert.equal(validatePassword('a'.repeat(69)+'Z1!'),true, '72-byte password remains supported');
  assert.equal(validatePassword('a'.repeat(72)+'Z1!'),false, 'complexity beyond bcrypt input must not be accepted');
  assert.equal(validatePassword('é'.repeat(34)+'Aa1!'),true, 'exactly 72 UTF-8 bytes');
  assert.equal(validatePassword('é'.repeat(35)+'Aa1!'),false, '74 bytes cannot be distinguished by bcrypt');
  assert.equal(validatePassword('😀'.repeat(18)+'Aa1!'),false, 'UTF-8 byte limit applies to supplementary characters');
});
test('authentication rejects oversized passwords before looking up an account',async()=>{
  const {createAuthenticator}=require('../src/platform/services/authentication.service');
  let lookups=0;
  const authenticate=createAuthenticator({Identity:{findOne(){lookups++;throw new Error('Unexpected directory lookup');}}});
  assert.equal(await authenticate({email:'person@example.com',password:'a'.repeat(72)+'Z1!'}),null);
  assert.equal(await authenticate({email:'person@example.com',password:'é'.repeat(35)+'Aa1!'}),null);
  assert.equal(lookups,0);
});
test('exact integer minor units and currency-specific decimals',()=>{
  assert.equal(mm.toMinor('1000','UGX'),1000);
  assert.equal(mm.toMinor('1000.25','KES'),100025);
  assert.equal(mm.toMinor('0','KES',true),0);
  for(const [v,c] of [['1000.25','UGX'],['-1','UGX'],['1e9','UGX'],['NaN','KES'],['0','UGX'],['1.234','KES']]) assert.throws(()=>mm.toMinor(v,c));
});
function sample(overrides={}){return {customer:'Sarah',network:'MTN',networkReference:'ABCD12345',currency:'UGX',amount:'5000',fee:'100',idempotencyKey:'a1234567-89ab-4abc-8def-0123456789ab',...overrides};}
test('mobile money rejects missing references and invalid economics',()=>{
  const v=mm.validate(sample(),'cash_in');assert.equal(v.amountMinor,5000);assert.equal(v.operation,'cash_in');
  assert.throws(()=>mm.validate(sample({networkReference:'--'}),'cash_out'));
  assert.throws(()=>mm.validate(sample({amount:'0'}),'cash_in'));
  assert.throws(()=>mm.validate(sample({fee:'6000'}),'cash_out'));
  assert.throws(()=>mm.validate(sample({idempotencyKey:''}),'cash_out'));
  assert.throws(()=>mm.validate(sample(),'random'));
});
test('reports enforce valid bounded date intervals',()=>{
  const d=mm.dateBounds({from:'2026-11-01',to:'2026-11-03'});
  assert.equal(d.$gte.toISOString(),'2026-11-01T00:00:00.000Z');
  assert.equal(d.$lt.toISOString(),'2026-11-04T00:00:00.000Z');
  assert.throws(()=>mm.dateBounds({from:'2026-02-30',to:'2026-03-01'}));
  assert.throws(()=>mm.dateBounds({from:'2026-01-01',to:'2026-06-01'}));
});
test('spreadsheet output escapes formulas and embedded delimiters',()=>{
  const csv=mm.toCsv([{createdAt:new Date('2026-11-03'),operation:'cash_in',customer:'=HYPERLINK("bad")',network:'MTN',networkReference:'+cmd',currency:'KES',amountMinor:12345,feeMinor:5,status:'pending_verification'}]);
  assert(csv.includes("'=HYPERLINK")); assert(csv.includes("'+cmd")); assert(csv.includes('123.45')); assert(csv.includes('0.05'));
});

test('staff permissions are server-defined and tenant owners cannot be self-invited',()=>{
  assert.deepEqual(permissionsFor('Mobile Money Operator'),['notifications.view','dashboard.view','mobile_money.view','mobile_money.cash_in','mobile_money.cash_out']);
  assert.deepEqual(permissionsFor('fake-role'),[]);
  assert(permissionsFor('Branch Manager').includes('branches.view'));
  assert(!permissionsFor('Branch Manager').includes('users.manage'));
  assert(!permissionsFor('Branch Manager').includes('mobile_money.review'));
  assert.equal(checkStaff({name:'Grace Teller',email:'grace@example.com',role:'Auditor'}).role,'Auditor');
  assert.throws(()=>checkStaff({name:'Bad',email:'bad@example.com',role:'Tenant Owner'}));
  assert.equal(checkStaff({name:'Branch Manager',email:'manager@example.com',role:'Branch Manager'}).role,'Branch Manager');
});
test('format currency summary exact even above Number.MAX_SAFE_INTEGER',()=>{
  assert.equal(mm.formatMoneyMinor('12345678901234567','UGX'),'UGX 12,345,678,901,234,567');
  assert.equal(mm.formatMoneyMinor('12345678901234567','KES'),'KES 123,456,789,012,345.67');
});
