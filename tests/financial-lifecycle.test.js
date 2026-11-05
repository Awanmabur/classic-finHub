'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const mongoose=require('mongoose');
const engine=require('../src/tenant/financial/transactionEngine.service');
const {financialOperationModel,financialEvidenceModel,financialExceptionModel}=require('../src/tenant/models');
const branch='507f1f77bcf86cd799439011',owner='507f1f77bcf86cd799439012';
const DB='classicfin_tenant_test_db';
const env={FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX:'ab'.repeat(32),
  FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX:'cd'.repeat(32)};
function intent(extra={}){
  return {branchId:branch,createdBy:owner,sourceType:'mobile_money',sourceRef:'provider:transaction:1234',
    provider:'test_gateway',providerRef:'gateway:external:1234',currency:'UGX',amountMinor:'10000',
    ledgerLines:[{accountCode:'CASH_UGX',side:'debit',amountMinor:'10000'},
      {accountCode:'FLOAT_MTN',side:'credit',amountMinor:'10000'}],...extra};
}
function evidence(extra={}){
  return {tenantDatabase:DB,provider:'test_gateway',kind:'callback',eventId:'gateway:event:1234',
    sourceType:'mobile_money',sourceRef:'provider:transaction:1234',providerRef:'gateway:external:1234',
    currency:'UGX',amountMinor:'10000',claimedStatus:'confirmed',issuedAt:'2026-11-03T17:00:00.000Z',...extra};
}
function sign(payload,secret=env.FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX){
  return crypto.createHmac('sha256',Buffer.from(secret,'hex')).update(JSON.stringify(payload)).digest('hex');
}
test('financial intents require balanced exact, branch-bound accounting and provider mapping',()=>{
  const normalized=engine.normalizeIntent(intent());
  assert.equal(normalized.amountMinor,'10000');
  assert.equal(normalized.ledgerLines.length,2);
  assert.equal(engine.normalizeIntent(intent({ledgerLines:[...intent().ledgerLines].reverse()})).fingerprint,normalized.fingerprint);
  for(const bad of ['0','-1','1e3','1.25','0005','1000000000000000000',Number.NaN])
    assert.throws(()=>engine.normalizeIntent(intent({amountMinor:bad})));
  assert.throws(()=>engine.normalizeIntent(intent({amountMinor:'9999'})),/differs/);
  assert.throws(()=>engine.normalizeIntent(intent({provider:'INVALID SPACE'})));
  assert.throws(()=>engine.normalizeIntent(intent({createdBy:'bad'})));
  assert.throws(()=>engine.normalizeIntent(intent({sourceType:'reversal'})));
  assert.throws(()=>engine.normalizeIntent(intent({currency:'USD'})));
});
test('gateway callback authenticates strict canonical, tenant-bound, time-limited evidence',()=>{
  const p=evidence(),s=sign(p),now=Date.parse(p.issuedAt);
  const verified=engine.authenticateEvidence(p,s,DB,env,now);
  assert.equal(verified.kind,'callback');
  assert.equal(verified.digest.length,64);
  assert.throws(()=>engine.authenticateEvidence(p,'0'.repeat(64),DB,env,now),/Untrusted/);
  assert.throws(()=>engine.authenticateEvidence(p,s,'classicfin_tenant_other_db',env,now),/tenant/);
  assert.throws(()=>engine.authenticateEvidence(p,s,DB,env,now+300001),/timestamp/);
  assert.throws(()=>engine.authenticateEvidence({...p,extra:'ignored'},s,DB,env,now),/shape/);
  assert.throws(()=>engine.authenticateEvidence({...p,amountMinor:'20000'},s,DB,env,now),/Untrusted/);
  assert.throws(()=>engine.authenticateEvidence(p,s,DB,{...env,FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX:'bad'},now),/not configured/);
  assert.throws(()=>engine.authenticateEvidence(p,s,DB,{...env,FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX:env.FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX},now),/different/);
});
test('statement evidence must use a separate signing key and cannot claim failures',()=>{
  const p=evidence({kind:'settlement',eventId:'gateway:statement:1234'}),now=Date.parse(p.issuedAt);
  const signed=sign(p,env.FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX);
  assert.equal(engine.authenticateEvidence(p,signed,DB,env,now).kind,'settlement');
  assert.throws(()=>engine.authenticateEvidence(p,sign(p),DB,env,now),/Untrusted/);
  assert.throws(()=>engine.authenticateEvidence({...p,claimedStatus:'failed'},signed,DB,env,now),/confirmed/);
});
test('provider records with changed economics, source, or provider cannot reconcile',()=>{
  const op=engine.normalizeIntent(intent());
  const p=evidence();
  assert(engine.evidenceMatchesOperation(p,op));
  for(const change of [{amountMinor:'11000'},{currency:'KES'},{providerRef:'gateway:wrong:1234'},
    {sourceRef:'provider:other:1234'},{provider:'other_gateway'}])
    assert(!engine.evidenceMatchesOperation({...p,...change},op));
  assert(!engine.evidenceMatchesOperation(p,null));
});
test('financial evidence is append-only and unique event IDs cannot overwrite history',()=>{
  const conn=mongoose.createConnection();
  const Op=financialOperationModel(conn),Ev=financialEvidenceModel(conn),Ex=financialExceptionModel(conn);
  assert(Op.schema.indexes().some(([k,v])=>k.sourceType===1&&k.sourceRef===1&&v.unique));
  assert(Op.schema.indexes().some(([k,v])=>k.provider===1&&k.providerRef===1&&v.unique));
  assert(Ev.schema.indexes().some(([k,v])=>k.provider===1&&k.kind===1&&k.eventId===1&&v.unique));
  assert(Ex.schema.indexes().some(([k,v])=>k.evidenceId===1&&v.unique));
  assert.equal(Ev.schema.options.strict,'throw');
  assert.equal(Ev.schema.options.versionKey,false);
  conn.destroy();
});
test('no tenant HTTP route exposes provider evidence reception, reconciliation, or generic posting',()=>{
  const routes=path.join(__dirname,'../src/tenant/routes');
  for(const f of fs.readdirSync(routes).filter(p=>p.endsWith('.js'))){
    const code=fs.readFileSync(path.join(routes,f),'utf8');
    assert(!/transactionEngine|receiveEvidence|registerIntent|reconcileOperation|postJournal/.test(code),f);
  }
});
