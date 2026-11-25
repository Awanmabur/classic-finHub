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
const {earnings}=require('../src/tenant/services/ownerReportEarnings.service');
const {models:fundsModels}=require('../src/tenant/treasury/models');
const {models:fundedModels}=require('../src/tenant/funded/models');

async function verifyOwnerEarnings(conn,branchId,actorId) {
  const Account=ledgerAccountModel(conn), Journal=ledgerJournalModel(conn), Posting=ledgerPostingModel(conn);
  const {batch:Batch}=fundsModels(conn);
  const {execution:Execution}=fundedModels(conn);
  const id=()=>new mongoose.Types.ObjectId();
  const tenant={_id:id()}, otherBranchId=id();
  const dateRange={$gte:new Date('2025-09-01T00:00Z'),$lt:new Date('2025-10-01T00:00Z')};
  const createdAt=new Date('2025-09-07T12:00Z'), priorPeriod=new Date('2025-08-31T23:59Z');
  const fingerprint='0'.repeat(64);
  const accounts=new Map();
  async function account(branchId,currency,category){
    const key=`${branchId}:${currency}:${category}`;
    if(!accounts.has(key))accounts.set(key,await Account.create({
      branchId,currency,category,code:`EARN_${currency}_${category.toUpperCase()}`,name:`Report ${category}`,createdBy:actorId
    }));
    return accounts.get(key)._id;
  }
  async function journal({branch=branchId,currency='UGX',category='income',side='credit',amountMinor,
    sourceType='treasury',sourceRef='LEGACY:'+id(),postedAt=createdAt,reverses}){
    const entry=await Journal.create({branchId:branch,currency,sourceType,sourceRef,
      actorId,fingerprint,createdAt:postedAt,...(reverses?{reverses}:{})});
    await Posting.create([
      {accountId:await account(branch,currency,category),side},
      {accountId:await account(branch,currency,'asset'),side:side==='credit'?'debit':'credit'}
    ].map((line,lineNo)=>({...line,journalId:entry._id,branchId:branch,currency,amountMinor,lineNo,createdAt:postedAt})));
    return entry._id;
  }
  async function batch(sourceType,sourceRef,postings,reversesBatchId=null){
    const _id=id(), journalIds=[];
    for(const posting of postings)journalIds.push(await journal({
      ...posting,sourceRef:`TRS:${_id}:${posting.currency||'UGX'}`
    }));
    await Batch.create({_id,tenantId:tenant._id,branchId:postings[0].branch||branchId,
      actorId,operatingActorId:actorId,sourceType,sourceRef,fingerprint,occurredAt:priorPeriod,
      createdAt:postings[0].postedAt||createdAt,description:'Owner earnings report ledger fixture',journalIds,reversesBatchId});
    return _id;
  }

  await journal({sourceType:'banking',amountMinor:'9007199254740993'});
  await journal({sourceType:'banking',amountMinor:'900',postedAt:dateRange.$lt});
  const legacyId=await journal({sourceType:'money_transfer',amountMinor:'12',postedAt:priorPeriod});
  await journal({sourceType:'reversal',side:'debit',amountMinor:'12',reverses:legacyId});
  await batch('forex','MFX:'+id(),[{currency:'USD',amountMinor:'200'},{amountMinor:'14'}]);
  const priorBatch=await batch('forex','MFX:'+id(),[{currency:'USD',amountMinor:'30',postedAt:priorPeriod}]);
  await batch('forex','REV:'+id(),[{currency:'USD',side:'debit',amountMinor:'30'}],priorBatch);
  await batch('forex','FUNDED:'+id(),[{amountMinor:'40'}]);
  const payoutId=id();
  const payoutBatch=await batch('forex','FUNDED:'+payoutId,[{currency:'USD',amountMinor:'53'}]);
  await batch('forex','PAYOUT-REV:'+id(),[{currency:'USD',side:'debit',amountMinor:'3'}],payoutBatch);
  await Execution.create({_id:payoutId,sourceType:'money_transfer',sourceId:id(),sourceReference:'TREASURY-FIXTURE',
    action:'transfer_payout',branchId,createdBy:actorId,idempotencyKey:crypto.randomUUID(),fingerprint,
    sourceFingerprint:fingerprint,sourceSnapshot:{currency:'UGX'},accounts:{},
    payoutFx:{targetCurrency:'USD',payoutMinor:'400',rateId:id(),rateDecimal:'0.0003',
      rateVersion:1,rateExpiresAt:dateRange.$lt},evidenceReference:'PAYOUT-FIXTURE',
    note:'Posted transfer payout fixture',status:'posted_manual',
    journalIds:(await Batch.findById(payoutBatch).lean()).journalIds});
  await batch('expenses','EXP:'+id(),[{category:'expense',side:'debit',amountMinor:'80'}]);
  await batch('expenses','EXP:'+id(),[{branch:otherBranchId,category:'expense',side:'debit',amountMinor:'25'}]);
  await journal({currency:'USD',amountMinor:'7'});

  const row=(moduleKey,currency,incomeMinor,expenseMinor,netMinor)=>({moduleKey,currency,incomeMinor,expenseMinor,netMinor});
  const result=await earnings(conn,tenant,{branchId},dateRange);
  assert.deepEqual(result.byModule,[
    row('banking','UGX','9007199254740993','0','9007199254740993'),
    row('expenses','UGX','0','80','-80'),
    row('forex','UGX','40','0','40'),
    row('mobile_money','UGX','14','0','14'),
    row('money_transfer','UGX','-12','0','-12'),
    row('mobile_money','USD','170','0','170'),
    row('money_transfer','USD','50','0','50'),
    row('unattributed','USD','7','0','7')
  ]);
  assert.deepEqual(result.byCurrency,[
    {currency:'UGX',incomeMinor:'9007199254741035',expenseMinor:'80',netMinor:'9007199254740955'},
    {currency:'USD',incomeMinor:'227',expenseMinor:'0',netMinor:'227'}
  ]);
  const allBranches=await earnings(conn,tenant,{},dateRange);
  assert.equal(allBranches.byCurrency.find(row=>row.currency==='UGX').expenseMinor,'105');
  assert.deepEqual(await earnings(conn,tenant,{branchId:id()},dateRange),{byModule:[],byCurrency:[]});
}

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
    await verifyOwnerEarnings(a,branch._id,ownerId);
    console.log('PASS: scratch tenant ledger posting, source replay, balanced trial, rollback, authorized reversal, exact offset, audit and isolation');
    console.log('PASS: owner earnings by posted date, branch, module and currency with exact signed amounts and reversal attribution');
  } finally {
    for(const [i,conn] of [a,b].entries()) {
      if(!/^classicfin_ledger_probe_[ab]_[0-9a-f]{16}$/.test(names[i]))throw new Error('Unsafe ledger scratch cleanup target');
      try{await conn.db.dropDatabase();}catch(e){console.error('Ledger scratch cleanup failed:',e.message);process.exitCode=1;}
    }
    await mongoose.disconnect();
  }
}
main().catch(async e=>{console.error('Ledger integration FAILED:',e.stack||e.message);process.exitCode=1;await mongoose.disconnect().catch(()=>{});});
