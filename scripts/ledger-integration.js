#!/usr/bin/env node
'use strict';
// Destructive tests only in random, self-owned loopback scratch databases.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const env=require('../src/config/env');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const {ensureTenantIndexes,branchModel,tenantUserModel,ledgerJournalModel,ledgerPostingModel,
  ledgerAccountModel,auditEventModel}=require('../src/tenant/models');
const ledger=require('../src/tenant/services/ledger.service');
async function main(){
  if(env.nodeEnv==='production')throw new Error('Ledger integration tests are prohibited in production');
  const url=new URL(env.mongoPlatformUri);
  if(url.protocol!=='mongodb:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) ||
    url.host.includes(',') || url.username || url.password)throw new Error('Integration requires unauthenticated single-host loopback replica set');
  await mongoose.connect(env.mongoPlatformUri,{serverSelectionTimeoutMS:6000,autoIndex:false});
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1,maxTimeMS:2000}));
  const nonce=crypto.randomBytes(8).toString('hex');
  const names=[`classicfin_ledger_probe_a_${nonce}`,`classicfin_ledger_probe_b_${nonce}`];
  const [a,b]=names.map(name=>mongoose.connection.useDb(name,{useCache:false}));
  try{
    await Promise.all([ensureTenantIndexes(a),ensureTenantIndexes(b)]);
    const ids=[...Array(3)].map(()=>new mongoose.Types.ObjectId());
    const [ownerId,operatorId,approverId]=ids;
    const branch=await branchModel(a).create({name:'Ledger integration test branch',code:'ledger-probe',currency:'UGX',createdBy:ownerId,updatedBy:ownerId});
    await tenantUserModel(a).create([
      {name:'Scratch owner',email:'owner@example.invalid',passwordHash:'test-not-real',role:'Tenant Owner',status:'active',mfaEnabledAt:new Date()},
      {name:'Scratch requester',email:'operator@example.invalid',passwordHash:'test-not-real',role:'Mobile Money Operator',status:'active',branchId:String(branch._id)},
      {name:'Scratch approver',email:'approver@example.invalid',passwordHash:'test-not-real',role:'Reconciliation Officer',status:'active',branchId:String(branch._id),mfaEnabledAt:new Date()}
    ].map((u,i)=>({...u,_id:ids[i]})));
    for(const acc of [
      {code:'CASH_UGX',name:'Cash on hand',category:'asset'},
      {code:'FLOAT_MTN',name:'MTN settlement clearing',category:'asset'}
    ])await ledger.createAccount(a,{...acc,actorId:String(ownerId),branchId:String(branch._id),currency:'UGX'});
    const input={branchId:String(branch._id),actorId:String(ownerId),sourceType:'mobile_money',sourceRef:`provider:receipt:${nonce}`,
      currency:'UGX',lines:[{accountCode:'CASH_UGX',side:'debit',amountMinor:'125000'},
        {accountCode:'FLOAT_MTN',side:'credit',amountMinor:'125000'}]};
    const first=await ledger.postJournal(a,input);
    assert(!first.duplicate);
    assert((await ledger.postJournal(a,input)).duplicate,'Identical source replay must be safe');
    await assert.rejects(ledger.postJournal(a,{...input,lines:input.lines.map(p=>({...p,amountMinor:'126000'}))}),e=>e.status===409);
    await assert.rejects(ledger.postJournal(b,input),e=>e.status===403,
      'Separate tenant DB must reject an unknown actor before inspecting foreign branch or journal data');
    let trial=await ledger.trialBalance(a,{branchId:String(branch._id),currency:'UGX'});
    assert.equal(trial.totalDebitsMinor,'125000');
    assert.equal(trial.totalCreditsMinor,'125000');
    assert.equal((await ledger.inspectJournal(a,String(first.journal._id))).valid,true);
    const before=await ledgerJournalModel(a).countDocuments();
    await assert.rejects(ledger.postJournal(a,{...input,sourceRef:`provider:missing:${nonce}`,
      lines:[{accountCode:'CASH_UGX',side:'debit',amountMinor:'100'},
        {accountCode:'NOT_PRESENT',side:'credit',amountMinor:'100'}]}),e=>e.status===409);
    assert.equal(await ledgerJournalModel(a).countDocuments(),before,'Failed posting must roll back journal');
    const approval={journalId:String(first.journal._id),requestedBy:String(operatorId),approvedBy:String(approverId),
      reason:'Provider confirms the earlier ledger posting was erroneous',ticketRef:`case:reversal:${nonce}`};
    const reversed=await ledger.reverseJournal(a,approval);
    assert(!reversed.duplicate);
    assert((await ledger.reverseJournal(a,approval)).duplicate,'Reversal replay must not create a second journal');
    await assert.rejects(ledger.reverseJournal(a,{...approval,ticketRef:`case:new:${nonce}`}),e=>e.status===409);
    await assert.rejects(ledger.reverseJournal(a,{...approval,journalId:String(reversed.journal._id)}),e=>e.status===409);
    assert.equal((await ledger.inspectJournal(a,String(reversed.journal._id))).valid,true);
    trial=await ledger.trialBalance(a,{branchId:String(branch._id),currency:'UGX'});
    assert.equal(trial.totalDebitsMinor,'250000');
    assert.equal(trial.totalCreditsMinor,'250000');
    assert(trial.rows.every(r=>r.netDebitMinor==='0'));
    assert.equal(await ledgerJournalModel(a).countDocuments(),2);
    assert.equal(await ledgerPostingModel(a).countDocuments(),4);
    assert.equal(await auditEventModel(a).countDocuments({action:/^ledger\./}),4);
    assert.equal(await ledgerAccountModel(b).countDocuments(),0);
    assert.equal(await ledgerJournalModel(b).countDocuments(),0);
    console.log('PASS: scratch tenant ledger posting, source replay, balanced trial, rollback, authorized reversal, exact offset, audit and isolation');
  } finally {
    for(const [i,conn] of [a,b].entries()) {
      if(!/^classicfin_ledger_probe_[ab]_[0-9a-f]{16}$/.test(names[i]))throw new Error('Unsafe ledger scratch cleanup target');
      try{await conn.db.dropDatabase();}catch(e){console.error('Ledger scratch cleanup failed:',e.message);process.exitCode=1;}
    }
    await mongoose.disconnect();
  }
}
main().catch(async e=>{console.error('Ledger integration FAILED:',e.stack||e.message);process.exitCode=1;await mongoose.disconnect().catch(()=>{});});
