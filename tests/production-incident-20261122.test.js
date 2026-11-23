'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('Treasury balances quarantine incomplete ledger accounts without posting or displaying amounts',()=>{
 const s=read('src/tenant/treasury/service.js');
 assert.match(s,/if\(!chart\)throw fail\('Funds account chart mapping is missing\./);
 assert.match(s,/await assertBookIntegrity\(conn,session,account\)/);
 assert.match(s,/integrityBlocked:true/);
 assert.match(s,/expectedMinor:null,expectedFormatted:/);
 assert.match(s,/availableMinor:'0'/);
 const routes=read('src/tenant/treasury/routes.js');
 assert.match(routes,/!blocked\.has\(String\(account\._id\)\)/);
 const view=read('src/views/tenant/treasury/index.ejs');
 assert.match(view,/Ledger review required/);
 assert.match(view,/account\.integrityBlocked\?/);
});
test('Offline HTTP failures cannot trigger connection oscillation or automatic financial replay',()=>{
 const s=read('public/js/offline-workspace.js');
 assert.doesNotMatch(s,/if \(response\.status >= 500\) setMode\('offline'\)/);
 assert.match(s,/draft\.retryUncertain = true/);
 assert.match(s,/draft\.state = 'needs_attention'/);
 assert.match(s,/if \(!draft\.retryUncertain\) rotateReference\(form\)/);
 assert.match(s,/Retry same reference/);
 assert.match(s,/current\.state = 'pending'/);
 assert.match(s,/await save\(draft\.id, current\)/);
});
test('Tenant quick setup never labels a failed opening as ready',()=>{
 const routes=read('src/tenant/setup/routes.js');
 assert.match(routes,/treasury\.assertBookIntegrity/);
 assert.match(routes,/!x\.integrityBlocked&&x\.status==='active'/);
 const view=read('src/views/tenant/setup/index.ejs');
 assert.match(view,/setupStatsGrid/);
 assert.match(view,/Ledger review required/);
 assert.match(view,/else if\(a\.openingBalanceMinor!=null\)/);
 assert.match(view,/Confirm actual opening/);
 assert.match(view,/name="actualBalance"/);
 assert.doesNotMatch(view,/name="confirmed"/);
 const css=read('public/css/tenant-quick-setup.css');
 assert.match(css,/grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
 assert.match(css,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});
test('One-time ledger reconstruction is evidence-fenced and requires verified backup',()=>{
 const s=read('scripts/repair-ghaja-orphan-ledger-20261122.js');
 assert.match(s,/const apply=process\.argv\.includes\('--apply'\)/);
 assert.match(s,/CLASSICFIN_REPAIR_BACKUP_VERIFIED/);
 assert.match(s,/RESTORABLE_BACKUP_CONFIRMED/);
 assert.match(s,/originalJournalId:EXPECT\.journal/);
 assert.match(s,/session\.withTransaction/);
 assert.match(s,/assertBookIntegrity\(conn,session,a\)/);
 assert.match(s,/balancesChanged:false/);
 assert.doesNotMatch(s,/dropDatabase\(|deleteMany\(|updateMany\(/);
});

test('Cross-currency switch is explicit and disabled state gives safe, non-secret feedback',()=>{
 const env=read('deploy/web.env.example');
 const settlement=read('src/tenant/services/momoFxSettlement.service.js');
 const diagnostics=read('src/utils/errorDiagnostics.js');
 assert.match(env,/CLASSICFIN_MOMO_FX_POSTING_ENABLED=false/);
 assert.match(settlement,/CLASSICFIN_MOMO_FX_POSTING_ENABLED!=='true'/);
 assert.match(settlement,/FX_RECORDING_DISABLED/);
 assert.match(diagnostics,/FX_RECORDING_DISABLED/);
});
