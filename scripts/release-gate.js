#!/usr/bin/env node
'use strict';
// Runs staging-only destructive integration checks and online npm security audit.
// Do not run against a production database: integration scripts enforce loopback.
const {spawnSync}=require('node:child_process');
if(process.env.NODE_ENV==='production'){
  console.error('Release verification must run against isolated staging/local infrastructure, not the live production process.');
  process.exit(1);
}
const steps=[
  [process.execPath,['scripts/check-secret-examples.js']],
  [process.execPath,['scripts/check-project.js']],
  [process.execPath,['--test','tests/*.test.js']],
  [process.execPath,['scripts/asset-budget.js']],
  [process.execPath,['scripts/db-doctor.js']],
  [process.execPath,['scripts/mongo-config-integration.js']],
  [process.execPath,['scripts/catalog-integration.js']],
  [process.execPath,['scripts/tenant-integration.js']],
  [process.execPath,['scripts/plan-builder-integration.js']],
  [process.execPath,['scripts/transaction-branch-integration.js']],
  [process.execPath,['scripts/branch-multicurrency-integration.js']],
  [process.execPath,['scripts/branch-view-integration.js']],
  [process.execPath,['scripts/manual-authorization-integration.js']],
  [process.execPath,['scripts/operation-authorization-integration.js']],
  [process.execPath,['scripts/mobile-workspace-integration.js']],
  [process.execPath,['scripts/operation-workspaces-integration.js']],
  [process.execPath,['scripts/customer-accounts-integration.js']],
  [process.execPath,['scripts/expenses-reports-integration.js']],
  [process.execPath,['scripts/treasury-integration.js']],
  [process.execPath,['scripts/wallet-funding-integration.js']],
  [process.execPath,['scripts/mobile-funds-integration.js']],
  [process.execPath,['scripts/funded-operations-integration.js']],
  [process.execPath,['scripts/expenses-treasury-integration.js']],
  [process.execPath,['scripts/reporting-cash-integration.js']],
  [process.execPath,['scripts/workspace-settings-integration.js']],
  [process.execPath,['scripts/workspace-operations-integration.js']],
  [process.execPath,['scripts/currency-integration.js']],
  [process.execPath,['scripts/sms-capture-integration.js']],
  [process.execPath,['scripts/sms-authorization-integration.js']],
  ['python3',['-m','unittest','discover','-s','tools/android-sms-relay','-p','test_*.py']],
  [process.execPath,['scripts/auth-integration.js']],
  [process.execPath,['scripts/login-render-integration.js']],
  [process.execPath,['scripts/mfa-policy-integration.js']],
  [process.execPath,['scripts/admin-integration.js']],
  [process.execPath,['scripts/appointments-integration.js']],
  [process.execPath,['scripts/review-integration.js']],
  [process.execPath,['scripts/db-integration.js']],
  [process.execPath,['scripts/infra-doctor.js']],
  [process.execPath,['scripts/catalog-publish.js']],
  [process.execPath,['scripts/commercial-integration.js']],
  [process.execPath,['scripts/outbox-integration.js']],
  [process.execPath,['scripts/ledger-integration.js']],
  [process.execPath,['scripts/financial-integration.js']],
  [process.execPath,['scripts/module-integration.js']],
  [process.execPath,['scripts/transfer-integration.js']],
  [process.execPath,['scripts/transfer-sms-integration.js']],
  [process.execPath,['scripts/branch-transfer-integration.js']],
  [process.execPath,['scripts/tenant-backup-integration.js']],
  [process.execPath,['scripts/banking-integration.js']],
  [process.execPath,['scripts/forex-integration.js']],
  [process.execPath,['scripts/analytics-integration.js']],
  [process.execPath,['scripts/approval-integration.js']],
  [process.execPath,['scripts/notification-integration.js']],
  [process.platform==='win32'?'npm.cmd':'npm',['audit','--audit-level=moderate']]
];
for(const [bin,args] of steps){
  // Node's test runner does not expand globs consistently on every platform.
  const actual=args[0]==='--test'?['--test',...require('node:fs').readdirSync('tests').filter(n=>n.endsWith('.test.js')).map(n=>'tests/'+n)]:args;
  console.log('CHECK:',bin,actual[0]);
  const result=spawnSync(bin,actual,{stdio:'inherit',env:process.env});
  if(result.status!==0){console.error('RELEASE BLOCKED:',actual.join(' '),'exit:',result.status,'signal:',result.signal||'none');process.exit(result.status||1);}
}
console.log('Local release checks passed. Live backup restore, TLS, browser, provider and load tests still require separate evidence.');
