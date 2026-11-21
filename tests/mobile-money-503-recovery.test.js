'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=filename=>fs.readFileSync(path.join(__dirname,'..',filename),'utf8');
test('offline status lookup is authenticated, tenant scoped, operation scoped and read only',()=>{
 const s=read('src/tenant/routes/offline.routes.js');
 assert.match(s,/router\.get\('\/offline\/operation-status'/);
 assert.match(s,/resolveTransactionBranch\(req\.tenantDb,req\.user\)/);
 assert.match(s,/idempotencyKey:reference,operatorId:req\.user\.id/);
 assert.match(s,/branchId:branch\._id,operation:operations\[action\]/);
 assert.match(s,/hasModuleForUser\(req\.tenant,req\.user,'mobile_money'\)/);
 assert.match(s,/status!=='recorded'\|\|record\.fundingState!=='book_recorded'/);
 assert.match(s,/state:'committed'/);
 assert.match(s,/state:'unknown'/);
 assert.match(s,/Cache-Control','private, no-store'/);
 assert.doesNotMatch(s,/router\.post\('\/offline\/operation-status'/);
});
test('offline client reconciles committed financial POST before uncertain failure and never rotates UUID',()=>{
 const s=read('public/js/offline-workspace.js');
 assert.match(s,/async function confirmedMobileRecord\(draft\)/);
 assert.match(s,/async function confirmSavedMobileRecord\(id\)/);
 assert.match(s,/if \(await confirmSavedMobileRecord\(candidate\.id\)\)/);
 assert.match(s,/if \(!draft\.retryUncertain\) rotateReference\(form\)/);
 assert.match(s,/Check server transaction/);
 assert.match(s,/draft\.retryUncertain = true/);
});
test('readiness enforces cashier, cash shift, ledger integrity, active branch rates and explicit posting switch',()=>{
 const routes=read('src/tenant/routes/mobileMoneyWorkspace.routes.js');
 const view=read('src/views/tenant/mobile-money/readiness.ejs');
 const entry=read('src/views/tenant/mobile-money/entry.ejs');
 assert.match(routes,/assertBookIntegrity\(req\.tenantDb,null,account\)/);
 assert.match(routes,/status:'open',openingVerifiedAt:\{\$ne:null\}/);
 assert.match(routes,/branchId:req\.operationBranch\._id/);
 assert.match(routes,/CLASSICFIN_MOMO_FX_POSTING_ENABLED==='true'/);
 assert.match(routes,/buyRateReady:rateBuy,sellRateReady:rateSell/);
 assert.match(routes,/cashInReady:shiftVerified/);
 assert.match(routes,/cashOutReady:shiftVerified/);
 assert.match(routes,/if\(!drawer\?\.postingReady\)blockers\.push/);
 assert.match(view,/Actual transaction readiness/);
 assert.match(view,/data\.readiness\.transactionPairs/);
 assert.match(entry,/href="\/tenant\/mobile-money\/readiness"/);
});
test('disabled FX posting is an expected client conflict rather than an unhelpful outage',()=>{
 const settlement=read('src/tenant/services/momoFxSettlement.service.js');
 assert.match(settlement,/FX_RECORDING_DISABLED/);
 assert.match(settlement,/no transaction was recorded by this request\.',409/);
});
