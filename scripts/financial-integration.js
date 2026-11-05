#!/usr/bin/env node
'use strict';
// Destructive checks ONLY on two random disposable loopback MongoDB databases.
// No real provider credentials, tenants, or financial settlement calls are used.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const env=require('../src/config/env');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const {branchModel,tenantUserModel,ensureTenantIndexes,ledgerAccountModel,ledgerJournalModel,
  financialOperationModel,financialEvidenceModel,financialExceptionModel,auditEventModel}=require('../src/tenant/models');
const ledger=require('../src/tenant/services/ledger.service');
const finance=require('../src/tenant/financial/transactionEngine.service');
const keys={FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX:crypto.randomBytes(32).toString('hex'),
  FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX:crypto.randomBytes(32).toString('hex')};
function sign(payload){const key=payload.kind==='callback'?keys.FINANCIAL_GATEWAY_CALLBACK_HMAC_KEY_HEX:keys.FINANCIAL_GATEWAY_STATEMENT_HMAC_KEY_HEX;
  return {payload,signature:crypto.createHmac('sha256',Buffer.from(key,'hex')).update(JSON.stringify(payload)).digest('hex')};}
function envelope(db,intent,kind,eventId,overrides={}){
  return {tenantDatabase:db.name,provider:intent.provider,kind,eventId,sourceType:intent.sourceType,
    sourceRef:intent.sourceRef,providerRef:intent.providerRef,currency:intent.currency,
    amountMinor:intent.amountMinor,claimedStatus:'confirmed',issuedAt:new Date().toISOString(),...overrides};
}
async function main(){
  if(env.nodeEnv==='production')throw Error('Financial integration is prohibited in production');
  const u=new URL(env.mongoPlatformUri);
  if(u.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||
    u.host.includes(',')||u.username||u.password)throw Error('Integration requires a single unauthenticated loopback replica set');
  await mongoose.connect(env.mongoPlatformUri,{serverSelectionTimeoutMS:6000,autoIndex:false});
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1,maxTimeMS:2000}));
  const nonce=crypto.randomBytes(8).toString('hex');
  const names=[`classicfin_financial_probe_a_${nonce}`,`classicfin_financial_probe_b_${nonce}`];
  const [a,b]=names.map(x=>mongoose.connection.useDb(x,{useCache:false}));
  try{
    await Promise.all([ensureTenantIndexes(a),ensureTenantIndexes(b)]);
    const ids=Array.from({length:3},()=>new mongoose.Types.ObjectId());
    const [owner,operator,reviewer]=ids;
    const branch=await branchModel(a).create({name:'Financial scratch branch',code:'finance-test',currency:'UGX',createdBy:owner,updatedBy:owner});
    await tenantUserModel(a).create([
      {_id:owner,name:'Scratch owner',email:'owner@sample.invalid',passwordHash:'fake',role:'Tenant Owner',mfaEnabledAt:new Date()},
      {_id:operator,name:'Scratch operator',email:'operator@sample.invalid',passwordHash:'fake',role:'Mobile Money Operator',branchId:String(branch._id)},
      {_id:reviewer,name:'Scratch reviewer',email:'reviewer@sample.invalid',passwordHash:'fake',role:'Reconciliation Officer',branchId:String(branch._id),mfaEnabledAt:new Date()}
    ]);
    for(const account of [{code:'CASH_UGX',name:'Cash settlement account',category:'asset'},
      {code:'FLOAT_MTN',name:'Provider clearing account',category:'asset'}])
      await ledger.createAccount(a,{...account,branchId:String(branch._id),actorId:String(owner),currency:'UGX'});
    const input=(suffix)=>({createdBy:String(operator),branchId:String(branch._id),sourceType:'mobile_money',
      sourceRef:`provider:transaction:${nonce}:${suffix}`,provider:'test_gateway',providerRef:`provider:external:${nonce}:${suffix}`,
      currency:'UGX',amountMinor:'12345',ledgerLines:[{accountCode:'CASH_UGX',side:'debit',amountMinor:'12345'},
        {accountCode:'FLOAT_MTN',side:'credit',amountMinor:'12345'}]});
    const op1=input('one');
    const created=await finance.registerIntent(a,op1);
    assert.equal(created.duplicate,false);
    assert.equal((await finance.registerIntent(a,op1)).duplicate,true);
    await assert.rejects(finance.registerIntent(a,{...op1,amountMinor:'12346'}),e=>e.status===400||e.status===409);
    await assert.rejects(finance.registerIntent(b,op1),e=>e.status===403||e.status===409);
    const cb=sign(envelope(a,op1,'callback',`callback:one:${nonce}`));
    assert.equal((await finance.receiveEvidence(a,cb,keys)).exception,false);
    assert.equal((await finance.receiveEvidence(a,cb,keys)).duplicate,true);
    await assert.rejects(finance.receiveEvidence(a,{...cb,signature:'00'.repeat(32)},keys),e=>e.status===401);
    await assert.rejects(finance.receiveEvidence(b,cb,keys),e=>e.status===403);
    await assert.rejects(finance.reconcileOperation(a,{operationId:String(created.operation._id),approvedBy:String(reviewer)}),e=>e.status===409);
    const statement=sign(envelope(a,op1,'settlement',`statement:one:${nonce}`));
    await finance.receiveEvidence(a,statement,keys);
    // A second statement line under a different event ID must raise an
    // exception instead of being silently treated as another settlement.
    const duplicateStatement=await finance.receiveEvidence(a,
      sign(envelope(a,op1,'settlement',`statement:duplicate:${nonce}`)),keys);
    assert.equal(duplicateStatement.exception,true);
    await assert.rejects(finance.reconcileOperation(a,{operationId:String(created.operation._id),approvedBy:String(reviewer)}),e=>e.status===409);
    const duplicateIssue=await financialExceptionModel(a).findOne({evidenceId:duplicateStatement.evidence._id});
    assert.equal(duplicateIssue.code,'DUPLICATE_SETTLEMENT');
    await finance.resolveException(a,{exceptionId:String(duplicateIssue._id),reviewerId:String(reviewer),
      note:'Confirmed duplicate statement line; the first provider statement remains authoritative'});
    await assert.rejects(finance.reconcileOperation(a,{operationId:String(created.operation._id),approvedBy:String(operator)}),e=>e.status===403);
    const rec=await finance.reconcileOperation(a,{operationId:String(created.operation._id),approvedBy:String(reviewer)});
    assert.equal(rec.duplicate,false);
    assert.equal((await finance.reconcileOperation(a,{operationId:String(created.operation._id),approvedBy:String(reviewer)})).duplicate,true);
    assert.equal((await ledger.inspectJournal(a,String(rec.journal._id))).valid,true);
    await assert.rejects(ledger.reverseJournal(a,{journalId:String(rec.journal._id),
      requestedBy:String(operator),approvedBy:String(reviewer),
      reason:'An external refund has not been independently confirmed by the provider',
      ticketRef:`case:cannot-reverse:${nonce}`}),e=>e.status===409);
    assert.equal(await ledgerJournalModel(a).countDocuments(),1);
    // The order of statement and callback must not matter.
    const op2=input('two'),c2=await finance.registerIntent(a,op2);
    await finance.receiveEvidence(a,sign(envelope(a,op2,'settlement',`statement:two:${nonce}`)),keys);
    await assert.rejects(finance.reconcileOperation(a,{operationId:String(c2.operation._id),approvedBy:String(reviewer)}),e=>e.status===409);
    await finance.receiveEvidence(a,sign(envelope(a,op2,'callback',`callback:two:${nonce}`)),keys);
    await finance.reconcileOperation(a,{operationId:String(c2.operation._id),approvedBy:String(reviewer)});
    // A definitive failure cannot be silently promoted to a verified settlement.
    const op3=input('three'),c3=await finance.registerIntent(a,op3);
    await finance.receiveEvidence(a,sign(envelope(a,op3,'callback',`callback:failed:${nonce}`,{claimedStatus:'failed'})),keys);
    await finance.receiveEvidence(a,sign(envelope(a,op3,'callback',`callback:late:${nonce}`)),keys);
    await assert.rejects(finance.reconcileOperation(a,{operationId:String(c3.operation._id),approvedBy:String(reviewer)}),e=>e.status===409);
    assert.equal((await financialOperationModel(a).findById(c3.operation._id)).status,'provider_failed');
    // Mismatch is durable exception, closure alone never fabricates a positive event.
    const op4=input('four'),c4=await finance.registerIntent(a,op4);
    await finance.receiveEvidence(a,sign(envelope(a,op4,'callback',`callback:mismatch:${nonce}`,{amountMinor:'99999'})),keys);
    const issue=await financialExceptionModel(a).findOne({operationId:c4.operation._id});
    assert.equal(issue.code,'ECONOMICS_MISMATCH');
    await finance.resolveException(a,{exceptionId:String(issue._id),reviewerId:String(reviewer),note:'Investigated mismatched signed event; verified corrected source evidence separately'});
    assert.equal((await financialOperationModel(a).findById(c4.operation._id)).status,'pending_verification');
    await finance.receiveEvidence(a,sign(envelope(a,op4,'callback',`callback:correct:${nonce}`)),keys);
    await finance.receiveEvidence(a,sign(envelope(a,op4,'settlement',`statement:four:${nonce}`)),keys);
    await finance.reconcileOperation(a,{operationId:String(c4.operation._id),approvedBy:String(reviewer)});
    assert.equal(await ledgerJournalModel(a).countDocuments(),3);
    assert.equal(await financialEvidenceModel(b).countDocuments(),0);
    assert.equal(await financialOperationModel(b).countDocuments(),0);
    assert((await auditEventModel(a).countDocuments({action:'financial.operation.reconciled'}))===3);
    const summary=await finance.reconciliationSummary(a,{branchId:String(branch._id)});
    assert.equal(summary.reconciled,3);
    console.log('PASS: tenant-isolated gateway verification, callback/statement matching, independent accounting, replay protection, out-of-order delivery, mismatch and failure exception recovery');
  }finally{
    for(let i=0;i<2;i++){
      if(!/^classicfin_financial_probe_[ab]_[0-9a-f]{16}$/.test(names[i]))throw Error('Unsafe financial integration scratch cleanup');
      try{await [a,b][i].db.dropDatabase();}catch(e){console.error('Cleanup failed:',e.message);process.exitCode=1;}
    }
    await mongoose.disconnect();
  }
}
main().catch(async e=>{console.error('Financial integration FAILED:',e.stack||e.message);process.exitCode=1;await mongoose.disconnect().catch(()=>{});});
