'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');
const service=require('../src/tenant/treasury/service');
const source=relative=>fs.readFileSync(path.join(__dirname,'..',relative),'utf8');

function settledAccount(){
 return {
  kind:'wallet',code:'WALLET_SSP_A1B2C3D4',status:'active',
  openingBalanceMinor:'15000',openingApprovedAt:new Date('2026-11-22'),
  reconciliationState:'matched',lastObservationStale:false,
  lastObservationAt:new Date('2026-11-23T10:00:00Z'),
  pendingOpeningId:null,bookBalanceMinor:'0',
  lastObservedMinor:'0',lastExpectedAtObservationMinor:'0',
  lastVarianceMinor:'0',selectionKey:undefined
 };
}
const confirm='WALLET_SSP_A1B2C3D4';

test('tenant owner can close a used account only after matched zero reconciliation',()=>{
 assert.doesNotThrow(()=>service.assertSettledAccountClosable(settledAccount(),confirm));
 assert.doesNotThrow(()=>service.assertSettledAccountClosable({...settledAccount(),selectionKey:'current-default'},confirm),
  'Owner can retire a settled default without a second settings step');
 for(const [field,value] of Object.entries({
  status:'held',bookBalanceMinor:'100',lastObservedMinor:'150',
  lastExpectedAtObservationMinor:'100',lastVarianceMinor:'-100',
  reconciliationState:'mismatch',lastObservationStale:true,
  lastObservationAt:null,pendingOpeningId:'pending'
 })){
  const account={...settledAccount(),[field]:value};
  assert.throws(()=>service.assertSettledAccountClosable(account,confirm),undefined,
   'Expected closing to reject '+field);
 }
 assert.throws(()=>service.assertSettledAccountClosable(settledAccount(),'WRONG'));
 assert.throws(()=>service.assertSettledAccountClosable({...settledAccount(),kind:'transfer_clearing'},confirm));
});

test('closing is a separate authenticated operation, not a hard delete',()=>{
 const routes=source('src/tenant/treasury/routes.js');
 const core=source('src/tenant/treasury/service.js');
 assert.match(routes,/router\.post\('\/accounts\/:id\/close',requirePermission\('treasury\.manage'\),throttle/);
 assert.match(core,/treasury\.account\.closed/);
 assert.match(core,/await assertBookIntegrity\(conn,session,account\)/);
 assert.match(core,/t\.account\.findOneAndUpdate/);
 assert.match(core,/lastMovement\.createdAt/);
 assert.doesNotMatch(core.slice(core.indexOf('async function closeSettledAccount'),core.indexOf('// Retained for existing integrations')),
  /deleteMany\(|deleteOne\(|findOneAndDelete\(/);
});

test('held guidance and close controls compile and do not offer a restore on used accounts',()=>{
 const detail=source('src/views/tenant/treasury/detail.ejs');
 const setup=source('src/views/tenant/setup/index.ejs');
 assert.doesNotThrow(()=>ejs.compile(detail));
 assert.doesNotThrow(()=>ejs.compile(setup));
 assert.match(detail,/Account on hold/);
 assert.match(detail,/Confirm remove/);
 assert.match(detail,/href="#account-settings"/);
 assert.match(detail,/href="#record-balance"/);
 assert.match(setup,/Closed · history retained/);
 assert.match(setup,/a\.openingBalanceMinor!==null\|\|Number\(a\.sequence\|\|0\)>0/);
});

test('a matched negative balance stays Held with an explanatory reason',()=>{
 const code=source('src/tenant/treasury/service.js');
 assert.match(code,/Negative bank\/account balance: spending requires settlement and a fresh balance check/);
 assert.match(code,/Negative account balance: settlement and a fresh check are required/);
 assert.match(code,/status:matched&&nonnegative\?'active':'held'/);
});

test('a two-click owner Remove action uses only server-derived account identity and never deletes ledger evidence',()=>{
 const routes=source('src/tenant/treasury/routes.js');
 const setup=source('src/views/tenant/setup/index.ejs');
 const detail=source('src/views/tenant/treasury/detail.ejs');
 assert.match(routes,/router\.post\('\/accounts\/:id\/remove'/);
 assert.match(routes,/treasury\.archiveUnusedAccount/);
 assert.match(routes,/treasury\.closeSettledAccount/);
 assert.match(routes,/status==='archived'/);
 assert.match(setup,/\/accounts\/<%= a\._id %>\/remove/);
 assert.match(detail,/\/accounts\/<%= account\._id %>\/remove/);
 assert.doesNotMatch(routes.slice(routes.indexOf("router.post('/accounts/:id/remove'"),routes.indexOf("router.post('/accounts/:id/archive'")),/deleteMany\(|deleteOne\(|findOneAndDelete\(/);
});

test('name-only account editing never submits defaults or financial values',()=>{
 const detail=source('src/views/tenant/treasury/detail.ejs');
 const routes=source('src/tenant/treasury/routes.js');
 const serviceSource=source('src/tenant/treasury/service.js');
 assert.match(detail,/action="\/tenant\/treasury\/accounts\/<%= account\._id %>\/rename"/);
 assert.match(detail,/Save name/);
 assert.match(routes,/router\.post\('\/accounts\/:id\/rename',requirePermission\('treasury\.manage'\),throttle/);
 assert.match(serviceSource,/async function renameAccount/);
 const fn=serviceSource.slice(serviceSource.indexOf('async function renameAccount'),serviceSource.indexOf('async function configureAccount'));
 assert.match(fn,/treasury\.account\.renamed/);
 assert.doesNotMatch(fn,/applyMovements|openingBalanceMinor|bookBalanceMinor|ledgerPostingModel|selectionKey:/);
 assert.equal(typeof service.renameAccount,'function');
});
